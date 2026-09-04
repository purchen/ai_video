import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { CostEstimate, ManualTtsAdapter, TtsRequest, TtsResult } from '../contracts';
import { readApprovedScript } from '../../review/approve';
import { hashCanonicalJson } from '../../script/hash-script';
import { scriptNarrationText } from '../../script/narration';
import type { ProjectStore } from '../../store/project-store';
import {
  canonicalVoiceAttemptId,
  nodeVoiceArtifactIo,
  readJson,
  sha256File,
  sha256Text,
  voicePath,
  voiceRoot,
  writeJson,
  writeMarkerAtomically,
  withVoiceAttempt,
  assertVoiceAttemptUnused,
  type VoiceArtifactIo,
} from '../../voice/artifacts';
import { audioMetadataSchema, type AudioConverter, type AudioProbe } from '../../voice/probe-audio';
import {
  sha256Schema,
  transactionIdSchema,
  voiceChargeSchema,
  voiceCommitMarkerSchema,
  voiceReportSchema,
  wordTimingsSchema,
  type VoiceReport,
} from '../../voice/schemas';

export const manualVoicePackageSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: transactionIdSchema,
  projectId: z.string().min(1),
  scriptHash: sha256Schema,
  text: z.string().min(1),
  textHash: sha256Schema,
  createdAt: z.string().datetime(),
});

export const manualVoicePackageMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: transactionIdSchema,
  projectId: z.string().min(1),
  scriptHash: sha256Schema,
  packageHash: sha256Schema,
  textHash: sha256Schema,
  committedAt: z.string().datetime(),
});

const manualRightsBase = {
  schemaVersion: z.literal(1),
  voiceId: z.string().min(1),
  authorizedBy: z.string().min(1),
  authorizedAt: z.string().datetime(),
  consentReference: z.string().min(1),
};

export const manualAudioAuthorizationSchema = z.discriminatedUnion('sourceKind', [
  z.object({
    ...manualRightsBase,
    sourceKind: z.literal('jianying-synthetic'),
    authorization: z.literal('synthetic'),
    voiceKind: z.literal('synthetic'),
    syntheticIdentifier: z.string().min(1),
  }).strict(),
  z.object({
    ...manualRightsBase,
    sourceKind: z.literal('cloned'),
    authorization: z.literal('user-authorized'),
    voiceKind: z.literal('cloned'),
    owner: z.string().min(1),
  }).strict(),
  z.object({
    ...manualRightsBase,
    sourceKind: z.literal('similar-real-person'),
    authorization: z.literal('user-authorized'),
    voiceKind: z.literal('similar-real-person'),
    owner: z.string().min(1),
  }).strict(),
]);

export type ManualVoicePackage = z.infer<typeof manualVoicePackageSchema>;
export type ManualAudioAuthorization = z.infer<typeof manualAudioAuthorizationSchema>;

export class JianyingManualTtsAdapter implements ManualTtsAdapter {
  readonly id = 'jianying-manual' as const;
  readonly mode = 'manual' as const;

  supports(_request: TtsRequest): boolean {
    return true;
  }

  async available(): Promise<boolean> {
    return true;
  }

  async estimate(_request: TtsRequest): Promise<CostEstimate> {
    return { providerId: this.id, currency: 'CNY', amount: 0, basis: 'manual import' };
  }

  async synthesize(_request: TtsRequest): Promise<TtsResult> {
    throw new Error('Manual Jianying TTS requires an imported audio file');
  }
}

export interface CreateManualVoicePackageRequest {
  store: ProjectStore;
  requestedScriptHash: string;
  now?: () => string;
  artifactIo?: VoiceArtifactIo;
}

export async function createManualVoicePackage(request: CreateManualVoicePackageRequest): Promise<ManualVoicePackage> {
  const approvedScript = await readApprovedScript(request.store);
  if (request.requestedScriptHash !== approvedScript.scriptHash) {
    throw new Error('manual package request does not match approved script hash');
  }
  const io = request.artifactIo ?? nodeVoiceArtifactIo;
  const createdAt = (request.now ?? (() => new Date().toISOString()))();
  const transactionId = randomUUID();
  const text = scriptNarrationText(approvedScript.script);
  const manualPackage = manualVoicePackageSchema.parse({
    schemaVersion: 1,
    transactionId,
    projectId: approvedScript.script.projectId,
    scriptHash: approvedScript.scriptHash,
    text,
    textHash: sha256Text(text),
    createdAt,
  });
  const root = voiceRoot(request.store);
  const packagesRoot = voicePath(request.store, 'manual-packages');
  const directory = voicePath(request.store, 'manual-packages', transactionId);
  const packagePath = join(directory, 'package.json');
  const textPath = join(directory, 'narration.txt');
  const markerPath = voicePath(request.store, 'manual-current.json');
  await io.mkdir(root);
  await io.mkdir(packagesRoot);
  await io.mkdir(directory);
  try {
    await writeJson(io, packagePath, manualPackage);
    await io.writeFile(textPath, text);
    const marker = manualVoicePackageMarkerSchema.parse({
      schemaVersion: 1,
      transactionId,
      projectId: manualPackage.projectId,
      scriptHash: manualPackage.scriptHash,
      packageHash: await sha256File(io, packagePath),
      textHash: await sha256File(io, textPath),
      committedAt: createdAt,
    });
    await writeMarkerAtomically(io, root, markerPath, marker);
    return manualPackage;
  } catch (error) {
    await io.rm(directory).catch(() => undefined);
    throw error;
  }
}

export async function readManualVoicePackage(
  store: ProjectStore,
  artifactIo: VoiceArtifactIo = nodeVoiceArtifactIo,
): Promise<{ package: ManualVoicePackage; text: string }> {
  const approvedScript = await readApprovedScript(store);
  let marker: ReturnType<typeof manualVoicePackageMarkerSchema.parse>;
  try {
    marker = manualVoicePackageMarkerSchema.parse(await readJson(artifactIo, voicePath(store, 'manual-current.json')));
  } catch {
    throw new Error('manual voice package is not committed');
  }
  if (marker.projectId !== approvedScript.script.projectId || marker.scriptHash !== approvedScript.scriptHash) {
    throw new Error('manual voice package marker does not match durable approved script');
  }
  const directory = voicePath(store, 'manual-packages', marker.transactionId);
  const packagePath = join(directory, 'package.json');
  const textPath = join(directory, 'narration.txt');
  try {
    const manualPackage = manualVoicePackageSchema.parse(await readJson(artifactIo, packagePath));
    const textBytes = await artifactIo.readFile(textPath);
    const text = textBytes.toString('utf8');
    const canonicalText = scriptNarrationText(approvedScript.script);
    if (marker.packageHash !== await sha256File(artifactIo, packagePath)
      || marker.textHash !== await sha256File(artifactIo, textPath)
      || manualPackage.transactionId !== marker.transactionId
      || manualPackage.projectId !== marker.projectId
      || manualPackage.scriptHash !== marker.scriptHash
      || manualPackage.textHash !== sha256Text(manualPackage.text)
      || textBytes.compare(Buffer.from(manualPackage.text, 'utf8')) !== 0
      || text !== canonicalText) {
      throw new Error('binding mismatch');
    }
    return { package: manualPackage, text };
  } catch {
    throw new Error('manual voice package commit does not match JSON and text artifacts');
  }
}

export interface ImportManualVoiceRequest {
  store: ProjectStore;
  attemptId: string;
  requestedScriptHash: string;
  audioPath: string;
  authorization?: ManualAudioAuthorization;
  converter: AudioConverter;
  probe: AudioProbe;
  now?: () => string;
  artifactIo?: VoiceArtifactIo;
}

export interface ReadyVoiceResult {
  status: 'READY';
  report: VoiceReport;
}

export async function importManualVoice(request: ImportManualVoiceRequest): Promise<ReadyVoiceResult> {
  const attemptId = canonicalVoiceAttemptId(request.attemptId);
  return withVoiceAttempt(request.store, attemptId, () => importManualVoiceExclusively({ ...request, attemptId }));
}

async function importManualVoiceExclusively(request: ImportManualVoiceRequest): Promise<ReadyVoiceResult> {
  const approvedScript = await readApprovedScript(request.store);
  if (request.requestedScriptHash !== approvedScript.scriptHash) {
    throw new Error('manual import request does not match approved script hash');
  }
  await readManualVoicePackage(request.store, request.artifactIo);
  if (!request.authorization) throw new Error('manual audio authorization is required');
  const rights = manualAudioAuthorizationSchema.parse(request.authorization);
  const io = request.artifactIo ?? nodeVoiceArtifactIo;
  const transactionId = transactionIdSchema.parse(request.attemptId);
  await assertVoiceAttemptUnused(request.store, transactionId, io);
  const generatedAt = (request.now ?? (() => new Date().toISOString()))();
  const root = voiceRoot(request.store);
  const directory = voicePath(request.store, 'transactions', transactionId);
  const temporaryWav = join(directory, 'master.tmp.wav');
  const masterPath = join(directory, 'master.wav');
  const timingsPath = join(directory, 'word-timings.json');
  const reportPath = join(directory, 'voice-report.json');
  const chargePath = join(directory, 'charge.json');
  const markerPath = voicePath(request.store, 'current.json');
  await io.mkdir(root);
  await io.mkdir(voicePath(request.store, 'transactions'));
  await io.mkdir(directory);
  let committed = false;
  try {
    await request.converter.convertToWav48k(request.audioPath, temporaryWav);
    const metadata = audioMetadataSchema.parse(await request.probe.probe(temporaryWav));
    assertManualAudio(metadata);
    if (metadata.durationMs < 55_000 || metadata.durationMs > 130_000) {
      throw new Error('manual voice duration must be between 55 and 130 seconds');
    }
    const authorizationReference = rights.consentReference;
    const authorizationHash = hashCanonicalJson(rights);
    const timings = wordTimingsSchema.parse({
      schemaVersion: 1,
      projectId: approvedScript.script.projectId,
      approvedScriptHash: approvedScript.scriptHash,
      transactionId,
      mode: 'fallback-empty',
      words: [],
    });
    const providerId = rights.authorization === 'synthetic' ? 'jianying-manual' : 'external-manual';
    const zeroCost = {
      providerId,
      currency: 'CNY',
      amount: 0,
      basis: 'manual imported audio; no provider charge',
    } as const;
    const charge = voiceChargeSchema.parse({
      schemaVersion: 1,
      transactionId,
      projectId: approvedScript.script.projectId,
      approvedScriptHash: approvedScript.scriptHash,
      providerId,
      reservationId: transactionId,
      idempotencyKey: `manual:${approvedScript.script.projectId}:${approvedScript.scriptHash}:${transactionId}`,
      authorizedMaxCny: 0,
      remainingAtAuthorizationCny: 0,
      budgetScope: 'single-process; multi-process requires Task9 project lock',
      estimate: zeroCost,
      actual: zeroCost,
      status: 'SETTLED_WITHIN_AUTHORIZATION',
      settledAt: generatedAt,
    });
    const report = voiceReportSchema.parse({
      schemaVersion: 1,
      status: 'READY',
      projectId: approvedScript.script.projectId,
      transactionId,
      approvedScriptHash: approvedScript.scriptHash,
      providerId,
      model: rights.sourceKind,
      voiceId: rights.voiceId,
      voiceKind: rights.voiceKind,
      authorization: rights.authorization,
      authorizationReference,
      authorizationHash,
      durationMs: metadata.durationMs,
      sampleRateHz: metadata.sampleRateHz,
      channels: metadata.channels,
      formatName: metadata.formatName,
      codecName: metadata.codecName,
      integratedLufs: metadata.integratedLufs,
      costCny: 0,
      generatedAt,
    });
    await io.rename(temporaryWav, masterPath);
    await writeJson(io, timingsPath, timings);
    await writeJson(io, reportPath, report);
    await writeJson(io, chargePath, charge);
    const marker = voiceCommitMarkerSchema.parse({
      schemaVersion: 1,
      transactionId,
      projectId: approvedScript.script.projectId,
      approvedScriptHash: approvedScript.scriptHash,
      masterHash: await sha256File(io, masterPath),
      timingsHash: await sha256File(io, timingsPath),
      reportHash: await sha256File(io, reportPath),
      chargeHash: await sha256File(io, chargePath),
      authorizationReference,
      authorizationHash,
      committedAt: generatedAt,
    });
    await writeMarkerAtomically(io, root, markerPath, marker);
    committed = true;
    return { status: 'READY', report };
  } finally {
    await io.rm(temporaryWav).catch(() => undefined);
    if (!committed) await io.rm(directory).catch(() => undefined);
  }
}

function assertManualAudio(metadata: { sampleRateHz: number; formatName: string; codecName: string }): void {
  if (metadata.sampleRateHz !== 48_000
    || !metadata.formatName.toLowerCase().split(',').includes('wav')
    || !metadata.codecName.toLowerCase().startsWith('pcm_')) {
    throw new Error('authoritative voice master must be 48 kHz PCM WAV');
  }
}
