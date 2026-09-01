import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BudgetGuard } from '../config';
import type { CostEstimate, TtsRequest, TtsResult } from '../providers/contracts';
import type { ProviderRegistry } from '../providers/registry';
import {
  createManualVoicePackage,
  type ManualVoicePackage,
} from '../providers/tts/manual';
import { readApprovedScript } from '../review/approve';
import { hashCanonicalJson } from '../script/hash-script';
import { scriptNarrationText } from '../script/narration';
import type { ProjectStore } from '../store/project-store';
import {
  nodeVoiceArtifactIo,
  readJson,
  sha256File,
  voicePath,
  voiceRoot,
  writeJson,
  writeMarkerAtomically,
  type VoiceArtifactIo,
} from './artifacts';
import { audioMetadataSchema, type AudioProbe } from './probe-audio';
import {
  costRecordSchema,
  voiceAuthorizationSchema,
  voiceChargeSchema,
  voiceCommitMarkerSchema,
  voiceReportSchema,
  wordTimingsSchema,
  type VoiceAuthorization,
  type VoiceCharge,
  type VoiceReport,
  type WordTimings,
} from './schemas';

export {
  voiceAuthorizationSchema,
  voiceChargeSchema,
  voiceCommitMarkerSchema,
  voiceReportSchema,
  wordTimingsSchema,
} from './schemas';
export type { VoiceAuthorization, VoiceCharge, VoiceReport, WordTimings } from './schemas';

export interface VoiceSelection {
  voiceId: string;
  kind: 'synthetic' | 'cloned' | 'similar-real-person';
  authorization?: VoiceAuthorization;
}

export interface GenerateVoiceRequest {
  requestedScriptHash: string;
  registry: ProviderRegistry;
  budgetGuard: BudgetGuard;
  store: ProjectStore;
  probe: AudioProbe;
  voice?: VoiceSelection;
  now?: () => string;
  artifactIo?: VoiceArtifactIo;
}

export type GenerateVoiceResult =
  | { status: 'READY'; report: VoiceReport }
  | { status: 'MANUAL_AUDIO_REQUIRED'; package: ManualVoicePackage };

export interface CommittedVoice {
  report: VoiceReport;
  timings: WordTimings;
  charge: VoiceCharge;
  masterPath: string;
}

export async function generateVoice(request: GenerateVoiceRequest): Promise<GenerateVoiceResult> {
  const approvedScript = await readApprovedScript(request.store);
  if (request.requestedScriptHash !== approvedScript.scriptHash) {
    throw new Error('voice request does not match approved script hash');
  }

  const voice = validateVoiceSelection(request.voice ?? { voiceId: 'alloy', kind: 'synthetic' });
  const authorization = authorizationBinding(voice);
  const text = scriptNarrationText(approvedScript.script);
  const transactionId = randomUUID();
  const transactionDirectory = voicePath(request.store, 'transactions', transactionId);
  const temporaryAudio = join(transactionDirectory, 'master.tmp.wav');
  const ttsRequest: TtsRequest = {
    approvedScriptHash: approvedScript.scriptHash,
    text,
    voiceId: voice.voiceId,
    voiceKind: voice.kind,
    authorization: authorization.kind,
    authorizationReference: authorization.reference,
    authorizationHash: authorization.hash,
    outputPath: temporaryAudio,
  };
  const adapter = await request.registry.selectAvailableTts(ttsRequest);
  if (adapter.mode === 'manual') {
    const manualPackage = await createManualVoicePackage({
      store: request.store,
      requestedScriptHash: approvedScript.scriptHash,
      now: request.now,
      artifactIo: request.artifactIo,
    });
    return { status: 'MANUAL_AUDIO_REQUIRED', package: manualPackage };
  }

  const io = request.artifactIo ?? nodeVoiceArtifactIo;
  const generatedAt = (request.now ?? (() => new Date().toISOString()))();
  const currentMarkerPath = voicePath(request.store, 'current.json');
  await io.mkdir(voiceRoot(request.store));
  await io.mkdir(voicePath(request.store, 'transactions'));
  await io.mkdir(transactionDirectory);

  const estimate = parseProviderCost(await adapter.estimate(ttsRequest), adapter.id, 'estimate');
  const budgetAuthorization = request.budgetGuard.authorize(estimate);
  await io.rm(currentMarkerPath);

  try {
    const synthesis = await adapter.synthesize(ttsRequest);
    assertSynthesisBinding(synthesis, adapter.id, ttsRequest);
    const actual = parseProviderCost(synthesis.cost, adapter.id, 'actual');
    const withinAuthorization = request.budgetGuard.settleAuthorized(budgetAuthorization, actual);
    const charge = voiceChargeSchema.parse({
      schemaVersion: 1,
      transactionId,
      projectId: approvedScript.script.projectId,
      approvedScriptHash: approvedScript.scriptHash,
      providerId: adapter.id,
      estimate,
      actual,
      status: withinAuthorization ? 'SETTLED_WITHIN_AUTHORIZATION' : 'SETTLED_OVER_AUTHORIZATION',
      settledAt: generatedAt,
    });
    const chargePath = join(transactionDirectory, 'charge.json');
    await writeJson(io, chargePath, charge);
    if (!withinAuthorization) throw new Error('actual TTS cost exceeds authorized amount');

    const metadata = audioMetadataSchema.parse(await request.probe.probe(temporaryAudio));
    assertAuthoritativeAudio(metadata);
    const timings = createTimings(
      approvedScript.script.projectId,
      approvedScript.scriptHash,
      transactionId,
      synthesis.wordTimings,
      metadata.durationMs,
    );
    const report = voiceReportSchema.parse({
      schemaVersion: 1,
      status: 'READY',
      projectId: approvedScript.script.projectId,
      transactionId,
      approvedScriptHash: approvedScript.scriptHash,
      providerId: synthesis.providerId,
      model: synthesis.model,
      voiceId: synthesis.voiceId,
      voiceKind: synthesis.voiceKind,
      authorization: synthesis.authorization,
      authorizationReference: synthesis.authorizationReference,
      authorizationHash: synthesis.authorizationHash,
      durationMs: metadata.durationMs,
      sampleRateHz: metadata.sampleRateHz,
      channels: metadata.channels,
      formatName: metadata.formatName,
      codecName: metadata.codecName,
      integratedLufs: metadata.integratedLufs,
      costCny: actual.amount,
      generatedAt,
    });

    const masterPath = join(transactionDirectory, 'master.wav');
    const timingsPath = join(transactionDirectory, 'word-timings.json');
    const reportPath = join(transactionDirectory, 'voice-report.json');
    await io.rename(temporaryAudio, masterPath);
    await writeJson(io, timingsPath, timings);
    await writeJson(io, reportPath, report);
    const marker = voiceCommitMarkerSchema.parse({
      schemaVersion: 1,
      transactionId,
      projectId: approvedScript.script.projectId,
      approvedScriptHash: approvedScript.scriptHash,
      masterHash: await sha256File(io, masterPath),
      timingsHash: await sha256File(io, timingsPath),
      reportHash: await sha256File(io, reportPath),
      chargeHash: await sha256File(io, chargePath),
      authorizationReference: authorization.reference,
      authorizationHash: authorization.hash,
      committedAt: generatedAt,
    });
    await writeMarkerAtomically(io, voiceRoot(request.store), currentMarkerPath, marker);
    return { status: 'READY', report };
  } finally {
    await io.rm(temporaryAudio).catch(() => undefined);
  }
}

export async function readCommittedVoice(
  store: ProjectStore,
  artifactIo: VoiceArtifactIo = nodeVoiceArtifactIo,
): Promise<CommittedVoice> {
  const approvedScript = await readApprovedScript(store);
  let marker: ReturnType<typeof voiceCommitMarkerSchema.parse>;
  try {
    marker = voiceCommitMarkerSchema.parse(await readJson(artifactIo, voicePath(store, 'current.json')));
  } catch {
    throw new Error('voice publication is not committed');
  }
  if (marker.projectId !== approvedScript.script.projectId
    || marker.approvedScriptHash !== approvedScript.scriptHash) {
    throw new Error('voice publication marker does not match durable approved script');
  }
  const directory = voicePath(store, 'transactions', marker.transactionId);
  const masterPath = join(directory, 'master.wav');
  const timingsPath = join(directory, 'word-timings.json');
  const reportPath = join(directory, 'voice-report.json');
  const chargePath = join(directory, 'charge.json');
  try {
    const timings = wordTimingsSchema.parse(await readJson(artifactIo, timingsPath));
    const report = voiceReportSchema.parse(await readJson(artifactIo, reportPath));
    const charge = voiceChargeSchema.parse(await readJson(artifactIo, chargePath));
    const hashesMatch = marker.masterHash === await sha256File(artifactIo, masterPath)
      && marker.timingsHash === await sha256File(artifactIo, timingsPath)
      && marker.reportHash === await sha256File(artifactIo, reportPath)
      && marker.chargeHash === await sha256File(artifactIo, chargePath);
    const bindingMatches = [timings, report, charge].every((artifact) => (
      artifact.projectId === marker.projectId
      && artifact.approvedScriptHash === marker.approvedScriptHash
      && artifact.transactionId === marker.transactionId
    ));
    if (!hashesMatch
      || !bindingMatches
      || charge.status !== 'SETTLED_WITHIN_AUTHORIZATION'
      || charge.providerId !== report.providerId
      || charge.actual.amount !== report.costCny
      || marker.authorizationReference !== report.authorizationReference
      || marker.authorizationHash !== report.authorizationHash) {
      throw new Error('binding mismatch');
    }
    assertTimingBounds(timings.words, report.durationMs);
    assertAuthoritativeAudio(report);
    return { report, timings, charge, masterPath };
  } catch {
    throw new Error('voice publication commit does not match its artifacts');
  }
}

function validateVoiceSelection(voice: VoiceSelection): VoiceSelection {
  if (!voice.voiceId.trim()) throw new Error('voiceId is required');
  if (voice.kind === 'synthetic') return { voiceId: voice.voiceId, kind: voice.kind };
  if (!voice.authorization) throw new Error('voice authorization is required for cloned voices');
  const authorization = voiceAuthorizationSchema.parse(voice.authorization);
  if (authorization.voiceId !== voice.voiceId || authorization.kind !== voice.kind) {
    throw new Error('voice authorization does not match the selected voice');
  }
  return { ...voice, authorization };
}

function authorizationBinding(voice: VoiceSelection): {
  kind: 'synthetic' | 'user-authorized';
  reference: string;
  hash: string;
} {
  if (voice.kind === 'synthetic') {
    const record = {
      schemaVersion: 1,
      authorization: 'synthetic',
      voiceId: voice.voiceId,
      identifier: `synthetic:voice:${voice.voiceId}`,
    } as const;
    return { kind: 'synthetic', reference: record.identifier, hash: hashCanonicalJson(record) };
  }
  const record = voiceAuthorizationSchema.parse(voice.authorization);
  return { kind: 'user-authorized', reference: record.consentReference, hash: hashCanonicalJson(record) };
}

function parseProviderCost(value: CostEstimate, providerId: string, kind: 'estimate' | 'actual'): CostEstimate {
  let cost: CostEstimate;
  try {
    cost = costRecordSchema.parse(value);
  } catch {
    throw new Error(`TTS ${kind} cost must be a finite, non-negative CNY value with an audit basis`);
  }
  if (cost.providerId !== providerId) {
    throw new Error(`TTS ${kind} cost must identify the selected provider`);
  }
  return cost;
}

function assertSynthesisBinding(result: TtsResult, adapterId: string, request: TtsRequest): void {
  if (result.audioPath !== request.outputPath) {
    throw new Error('TTS provider must write only to the requested temporary output path');
  }
  if (result.providerId !== adapterId
    || result.voiceId !== request.voiceId
    || result.voiceKind !== request.voiceKind
    || result.authorization !== request.authorization
    || result.authorizationReference !== request.authorizationReference
    || result.authorizationHash !== request.authorizationHash) {
    throw new Error('TTS result does not match selected provider and voice authorization');
  }
}

function assertAuthoritativeAudio(metadata: {
  sampleRateHz: number;
  formatName: string;
  codecName: string;
}): void {
  const formats = metadata.formatName.toLowerCase().split(',');
  if (metadata.sampleRateHz !== 48_000
    || !formats.includes('wav')
    || !metadata.codecName.toLowerCase().startsWith('pcm_')) {
    throw new Error('authoritative voice master must be 48 kHz PCM WAV');
  }
}

function createTimings(
  projectId: string,
  approvedScriptHash: string,
  transactionId: string,
  words: TtsResult['wordTimings'],
  durationMs: number,
): WordTimings {
  const normalizedWords = words?.length ? words : [];
  try {
    assertTimingBounds(normalizedWords, durationMs);
    return wordTimingsSchema.parse({
      schemaVersion: 1,
      projectId,
      approvedScriptHash,
      transactionId,
      mode: normalizedWords.length ? 'provider' : 'fallback-empty',
      words: normalizedWords,
    });
  } catch {
    throw new Error('word timings must be monotonic, non-overlapping, and within voice duration');
  }
}

function assertTimingBounds(words: WordTimings['words'], durationMs: number): void {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startMs > word.endMs
      || word.endMs > durationMs
      || (index > 0 && word.startMs < words[index - 1].endMs)) {
      throw new Error('word timings out of bounds');
    }
  }
}
