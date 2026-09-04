import { join } from 'node:path';
import type { BudgetAuthorization, BudgetGuard } from '../config';
import type { CostEstimate, TtsRequest, TtsResult } from '../providers/contracts';
import type { ProviderRegistry } from '../providers/registry';
import { createManualVoicePackage, type ManualVoicePackage } from '../providers/tts/manual';
import { readApprovedScript } from '../review/approve';
import { hashCanonicalJson } from '../script/hash-script';
import { scriptNarrationText } from '../script/narration';
import type { ProjectStore } from '../store/project-store';
import {
  canonicalVoiceAttemptId,
  nodeVoiceArtifactIo,
  readJson,
  sha256File,
  voicePath,
  voiceRoot,
  writeJson,
  writeMarkerAtomically,
  withVoiceAttempt,
  assertVoiceAttemptUnused,
  type VoiceArtifactIo,
} from './artifacts';
import { audioMetadataSchema, type AudioMetadata, type AudioProbe, type AudioConverter } from './probe-audio';
import {
  costRecordSchema,
  transactionIdSchema,
  voiceAttemptAuditSchema,
  voiceAuthorizationSchema,
  voiceChargeSchema,
  voiceCommitMarkerSchema,
  voiceReportSchema,
  voiceReservationAuditSchema,
  voiceResultAuditSchema,
  voiceSettlementAuditSchema,
  wordTimingsSchema,
  type VoiceAttemptAudit,
  type VoiceAuthorization,
  type VoiceCharge,
  type VoiceCommitMarker,
  type VoiceReport,
  type VoiceReservationAudit,
  type VoiceResultAudit,
  type VoiceSettlementAudit,
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

const budgetScope = 'single-process; multi-process requires Task9 project lock' as const;

export interface VoiceSelection {
  voiceId: string;
  kind: 'synthetic' | 'cloned' | 'similar-real-person';
  authorization?: VoiceAuthorization;
}

export interface GenerateVoiceRequest {
  attemptId: string;
  requestedScriptHash: string;
  registry: ProviderRegistry;
  budgetGuard: BudgetGuard;
  store: ProjectStore;
  probe: AudioProbe;
  converter?: AudioConverter;
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

export interface VoiceAttemptAuditBundle {
  attempt: VoiceAttemptAudit;
  reservation?: VoiceReservationAudit;
  settlement?: VoiceSettlementAudit;
  charge?: VoiceCharge;
  result?: VoiceResultAudit;
}

export async function generateVoice(request: GenerateVoiceRequest): Promise<GenerateVoiceResult> {
  const attemptId = canonicalVoiceAttemptId(request.attemptId);
  return withVoiceAttempt(request.store, attemptId, () => generateVoiceExclusively({ ...request, attemptId }));
}

async function generateVoiceExclusively(request: GenerateVoiceRequest): Promise<GenerateVoiceResult> {
  const approvedScript = await readApprovedScript(request.store);
  if (request.requestedScriptHash !== approvedScript.scriptHash) {
    throw new Error('voice request does not match approved script hash');
  }
  const attemptId = transactionIdSchema.parse(request.attemptId);
  const idempotencyKey = `voice:${approvedScript.script.projectId}:${approvedScript.scriptHash}:${attemptId}`;
  const io = request.artifactIo ?? nodeVoiceArtifactIo;
  const existing = await tryReadAttemptAudit(request.store, attemptId, io);
  if (!existing) await assertVoiceAttemptUnused(request.store, attemptId, io);
  if (existing) {
    assertAttemptMatches(existing.attempt, approvedScript.script.projectId, approvedScript.scriptHash);
    assertAuditBundle(existing);
    if (existing.result && existing.attempt.status !== 'OVER_AUTHORIZATION') {
      const recovered = await verifyTransaction(request.store, existing.result.marker, request.probe, io);
      await writeMarkerAtomically(
        io,
        voiceRoot(request.store),
        voicePath(request.store, 'current.json'),
        existing.result.marker,
      );
      await writeAttemptStatus(io, request.store, existing.attempt, 'COMMITTED', now(request));
      return { status: 'READY', report: recovered.report };
    }
    if (existing.attempt.status === 'OVER_AUTHORIZATION') {
      throw new Error('actual TTS cost exceeds authorized amount');
    }
    if (existing.attempt.status !== 'RESERVED') {
      throw new Error('voice attempt requires manual recovery before another paid call');
    }
    // Historical paid identities must never be silently rebound to a canonical retry.
    if (existing.attempt.attemptId !== attemptId
      || existing.attempt.transactionId !== attemptId
      || existing.attempt.idempotencyKey !== idempotencyKey) {
      throw new Error('voice attempt identity requires manual recovery before another paid call');
    }
  }

  const voice = validateVoiceSelection(request.voice ?? { voiceId: 'alloy', kind: 'synthetic' });
  const authorization = authorizationBinding(voice);
  const text = scriptNarrationText(approvedScript.script);
  const transactionId = attemptId;
  const transactionDirectory = voicePath(request.store, 'transactions', transactionId);
  const temporaryAudio = join(transactionDirectory, 'master.tmp.wav');
  const convertedAudio = join(transactionDirectory, 'master.converted.tmp.wav');
  const ttsRequest: TtsRequest = {
    idempotencyKey,
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

  const timestamp = now(request);
  const auditDirectory = voicePath(request.store, 'audit', attemptId);
  await io.mkdir(voiceRoot(request.store));
  await io.mkdir(voicePath(request.store, 'audit'));
  await io.mkdir(auditDirectory);

  const estimate = parseProviderCost(await adapter.estimate(ttsRequest), adapter.id, 'estimate');
  const budgetAuthorization = request.budgetGuard.reserve(attemptId, estimate);
  const attempt = existing?.attempt ?? voiceAttemptAuditSchema.parse({
    schemaVersion: 1,
    attemptId,
    transactionId,
    projectId: approvedScript.script.projectId,
    approvedScriptHash: approvedScript.scriptHash,
    providerId: adapter.id,
    idempotencyKey,
    status: 'RESERVED',
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const reservation = voiceReservationAuditSchema.parse({
    schemaVersion: 1,
    attemptId,
    projectId: approvedScript.script.projectId,
    approvedScriptHash: approvedScript.scriptHash,
    providerId: adapter.id,
    idempotencyKey,
    estimate,
    authorizedMaxCny: budgetAuthorization.maximumAmountCny,
    remainingAtAuthorizationCny: budgetAuthorization.remainingAtAuthorizationCny,
    budgetScope,
    reservedAt: timestamp,
  });
  await writeAudit(io, auditDirectory, 'reservation.json', reservation);
  await writeAudit(io, auditDirectory, 'attempt.json', attempt);
  await writeAttemptStatus(io, request.store, attempt, 'PROVIDER_CALL_STARTED', timestamp);

  let resultPersisted = false;
  let terminalStatus: VoiceAttemptAudit['status'] | undefined;
  try {
    await io.mkdir(voicePath(request.store, 'transactions'));
    await io.mkdir(transactionDirectory);
    const synthesis = await adapter.synthesize(ttsRequest);
    assertSynthesisBinding(synthesis, adapter.id, ttsRequest);
    const actual = parseProviderCost(synthesis.cost, adapter.id, 'actual');
    const settlementResult = request.budgetGuard.settleReservation(attemptId, actual);
    const settlement = voiceSettlementAuditSchema.parse({
      schemaVersion: 1,
      attemptId,
      actual,
      withinAuthorization: settlementResult.withinAuthorization,
      settledAt: timestamp,
    });
    const charge = createCharge(
      attemptId,
      approvedScript.script.projectId,
      approvedScript.scriptHash,
      adapter.id,
      idempotencyKey,
      estimate,
      actual,
      budgetAuthorization,
      settlementResult.withinAuthorization,
      timestamp,
    );
    await writeAudit(io, auditDirectory, 'settlement.json', settlement);
    await writeAudit(io, auditDirectory, 'charge.json', charge);
    if (!settlementResult.withinAuthorization) {
      terminalStatus = 'OVER_AUTHORIZATION';
      await writeAttemptStatus(io, request.store, attempt, terminalStatus, timestamp);
      throw new Error('actual TTS cost exceeds authorized amount');
    }

    let metadata = audioMetadataSchema.parse(await request.probe.probe(temporaryAudio));
    let authoritativePath = temporaryAudio;
    if (!isAuthoritativeAudio(metadata) && request.converter) {
      await request.converter.convertToWav48k(temporaryAudio, convertedAudio);
      metadata = audioMetadataSchema.parse(await request.probe.probe(convertedAudio));
      authoritativePath = convertedAudio;
    }
    assertAuthoritativeAudio(metadata);
    const timings = createTimings(
      approvedScript.script.projectId,
      approvedScript.scriptHash,
      transactionId,
      synthesis.wordTimings,
      metadata.durationMs,
    );
    const report = createReport(
      approvedScript.script.projectId,
      approvedScript.scriptHash,
      transactionId,
      synthesis,
      metadata,
      actual.amount,
      timestamp,
    );
    const masterPath = join(transactionDirectory, 'master.wav');
    const timingsPath = join(transactionDirectory, 'word-timings.json');
    const reportPath = join(transactionDirectory, 'voice-report.json');
    const chargePath = join(transactionDirectory, 'charge.json');
    await io.rename(authoritativePath, masterPath);
    await writeJson(io, timingsPath, timings);
    await writeJson(io, reportPath, report);
    await writeJson(io, chargePath, charge);
    const marker = await createMarker(
      io,
      approvedScript.script.projectId,
      approvedScript.scriptHash,
      transactionId,
      authorization.reference,
      authorization.hash,
      timestamp,
      masterPath,
      timingsPath,
      reportPath,
      chargePath,
    );
    const resultAudit = voiceResultAuditSchema.parse({
      schemaVersion: 1,
      attemptId,
      transactionId,
      marker,
      persistedAt: timestamp,
    });
    await writeAudit(io, auditDirectory, 'result.json', resultAudit);
    resultPersisted = true;
    await writeAttemptStatus(io, request.store, attempt, 'RECOVERABLE', timestamp);
    await writeMarkerAtomically(io, voiceRoot(request.store), voicePath(request.store, 'current.json'), marker);
    await writeAttemptStatus(io, request.store, attempt, 'COMMITTED', timestamp);
    return { status: 'READY', report };
  } catch (error) {
    if (resultPersisted) {
      await writeAttemptStatus(io, request.store, attempt, 'RECOVERABLE', timestamp).catch(() => undefined);
    } else {
      await io.rm(transactionDirectory).catch(() => undefined);
      if (!terminalStatus) {
        await writeAttemptStatus(
          io,
          request.store,
          attempt,
          'BLOCKED_MANUAL_RECOVERY',
          timestamp,
        ).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await io.rm(temporaryAudio).catch(() => undefined);
    await io.rm(convertedAudio).catch(() => undefined);
  }
}

export async function readCommittedVoice(
  store: ProjectStore,
  probe: AudioProbe,
  artifactIo: VoiceArtifactIo = nodeVoiceArtifactIo,
): Promise<CommittedVoice> {
  const approvedScript = await readApprovedScript(store);
  let marker: VoiceCommitMarker;
  try {
    marker = voiceCommitMarkerSchema.parse(await readJson(artifactIo, voicePath(store, 'current.json')));
  } catch {
    throw new Error('voice publication is not committed');
  }
  if (marker.projectId !== approvedScript.script.projectId || marker.approvedScriptHash !== approvedScript.scriptHash) {
    throw new Error('voice publication marker does not match durable approved script');
  }
  return verifyTransaction(store, marker, probe, artifactIo);
}

export async function readVoiceAttemptAudit(
  store: ProjectStore,
  attemptIdInput: string,
  artifactIo: VoiceArtifactIo = nodeVoiceArtifactIo,
): Promise<VoiceAttemptAuditBundle> {
  const attemptId = canonicalVoiceAttemptId(attemptIdInput);
  const approvedScript = await readApprovedScript(store);
  const bundle = await tryReadAttemptAudit(store, attemptId, artifactIo);
  if (!bundle) throw new Error('voice attempt audit was not found');
  assertAttemptMatches(bundle.attempt, approvedScript.script.projectId, approvedScript.scriptHash);
  assertAuditBundle(bundle);
  return bundle;
}

export async function cleanupVoiceArtifacts(
  store: ProjectStore,
  options: { keepRecentCommitted: number },
  artifactIo: VoiceArtifactIo = nodeVoiceArtifactIo,
): Promise<void> {
  const retained = new Set<string>();
  try {
    const current = voiceCommitMarkerSchema.parse(await readJson(artifactIo, voicePath(store, 'current.json')));
    retained.add(current.transactionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const committed: Array<{ id: string; updatedAt: string }> = [];
  let attemptIds: string[];
  try {
    attemptIds = await artifactIo.readdir(voicePath(store, 'audit'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    attemptIds = [];
  }
  for (const attemptId of attemptIds) {
    transactionIdSchema.parse(attemptId);
    const bundle = await tryReadAttemptAudit(store, attemptId, artifactIo);
    if (!bundle) throw new Error('voice cleanup audit is incomplete');
    assertAuditBundle(bundle);
    if (bundle.attempt.attemptId !== attemptId) throw new Error('voice cleanup audit directory mismatch');
    // Committed history still follows the existing bounded retention policy.
    // An unpublished result is recoverable even if its status write was interrupted.
    if (bundle.result && bundle.attempt.status !== 'COMMITTED') retained.add(bundle.attempt.transactionId);
    if (bundle.attempt.status === 'COMMITTED') {
      committed.push({ id: bundle.attempt.transactionId, updatedAt: bundle.attempt.updatedAt });
    }
  }
  committed.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  for (const entry of committed.slice(0, Math.max(0, options.keepRecentCommitted))) retained.add(entry.id);
  try {
    for (const transactionId of await artifactIo.readdir(voicePath(store, 'transactions'))) {
      if (!retained.has(transactionId)) await artifactIo.rm(voicePath(store, 'transactions', transactionId));
    }
  } catch {
    // Transactions directory may not exist yet.
  }
}

async function verifyTransaction(
  store: ProjectStore,
  marker: VoiceCommitMarker,
  probe: AudioProbe,
  artifactIo: VoiceArtifactIo,
): Promise<CommittedVoice> {
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
    const metadata = audioMetadataSchema.parse(await probe.probe(masterPath));
    assertAuthoritativeAudio(metadata);
    if (metadata.durationMs !== report.durationMs
      || metadata.sampleRateHz !== report.sampleRateHz
      || metadata.channels !== report.channels
      || metadata.formatName !== report.formatName
      || metadata.codecName !== report.codecName) {
      throw new Error('re-probe mismatch');
    }
    assertTimingBounds(timings.words, report.durationMs);
    return { report, timings, charge, masterPath };
  } catch {
    throw new Error('voice publication commit does not match its artifacts');
  }
}

async function tryReadAttemptAudit(
  store: ProjectStore,
  attemptId: string,
  io: VoiceArtifactIo,
): Promise<VoiceAttemptAuditBundle | undefined> {
  const directory = voicePath(store, 'audit', attemptId);
  let attemptBytes: Buffer;
  try {
    attemptBytes = await io.readFile(join(directory, 'attempt.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
  const attempt = voiceAttemptAuditSchema.parse(JSON.parse(attemptBytes.toString('utf8')) as unknown);
  return {
    attempt,
    reservation: await optionalAudit(io, join(directory, 'reservation.json'), voiceReservationAuditSchema),
    settlement: await optionalAudit(io, join(directory, 'settlement.json'), voiceSettlementAuditSchema),
    charge: await optionalAudit(io, join(directory, 'charge.json'), voiceChargeSchema),
    result: await optionalAudit(io, join(directory, 'result.json'), voiceResultAuditSchema),
  };
}

async function optionalAudit<T>(
  io: VoiceArtifactIo,
  path: string,
  schema: { parse(value: unknown): T },
): Promise<T | undefined> {
  let bytes: Buffer;
  try {
    bytes = await io.readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
  return schema.parse(JSON.parse(bytes.toString('utf8')) as unknown);
}

async function writeAudit(io: VoiceArtifactIo, directory: string, name: string, value: unknown): Promise<void> {
  await writeMarkerAtomically(io, directory, join(directory, name), value);
}

async function writeAttemptStatus(
  io: VoiceArtifactIo,
  store: ProjectStore,
  attempt: VoiceAttemptAudit,
  status: VoiceAttemptAudit['status'],
  updatedAt: string,
): Promise<void> {
  const updated = voiceAttemptAuditSchema.parse({ ...attempt, status, updatedAt });
  await writeAudit(io, voicePath(store, 'audit', attempt.attemptId), 'attempt.json', updated);
}

function assertAttemptMatches(attempt: VoiceAttemptAudit, projectId: string, scriptHash: string): void {
  if (attempt.projectId !== projectId || attempt.approvedScriptHash !== scriptHash) {
    throw new Error('voice attempt audit does not match durable approved script');
  }
}

function assertAuditBundle(bundle: VoiceAttemptAuditBundle): void {
  const { attempt, reservation, settlement, charge, result } = bundle;
  if (!reservation
    || reservation.attemptId !== attempt.attemptId
    || reservation.projectId !== attempt.projectId
    || reservation.approvedScriptHash !== attempt.approvedScriptHash
    || reservation.providerId !== attempt.providerId
    || reservation.idempotencyKey !== attempt.idempotencyKey) {
    throw new Error('voice attempt reservation audit does not match the attempt');
  }
  const settledStatus = attempt.status === 'OVER_AUTHORIZATION'
    || attempt.status === 'RECOVERABLE'
    || attempt.status === 'COMMITTED';
  if ((settledStatus || charge || settlement || result) && (!charge || !settlement)) {
    throw new Error('voice attempt settlement audit is incomplete');
  }
  if (charge && settlement) {
    const costsMatch = settlement.actual.providerId === charge.actual.providerId
      && settlement.actual.currency === charge.actual.currency
      && settlement.actual.amount === charge.actual.amount
      && settlement.actual.basis === charge.actual.basis;
    if (!costsMatch
      || settlement.attemptId !== attempt.attemptId
      || settlement.withinAuthorization !== (charge.status === 'SETTLED_WITHIN_AUTHORIZATION')
      || charge.transactionId !== attempt.transactionId
      || charge.projectId !== attempt.projectId
      || charge.approvedScriptHash !== attempt.approvedScriptHash
      || charge.providerId !== attempt.providerId
      || charge.reservationId !== attempt.attemptId
      || charge.idempotencyKey !== attempt.idempotencyKey) {
      throw new Error('voice attempt charge audit does not match the reservation and settlement');
    }
  }
  if (result && (result.attemptId !== attempt.attemptId
    || result.transactionId !== attempt.transactionId
    || result.marker.transactionId !== attempt.transactionId
    || result.marker.projectId !== attempt.projectId
    || result.marker.approvedScriptHash !== attempt.approvedScriptHash)) {
    throw new Error('voice attempt result audit does not match the attempt');
  }
  if ((attempt.status === 'RECOVERABLE' || attempt.status === 'COMMITTED') && !result) {
    throw new Error('voice attempt result audit is missing');
  }
}

function createCharge(
  transactionId: string,
  projectId: string,
  scriptHash: string,
  providerId: string,
  idempotencyKey: string,
  estimate: CostEstimate,
  actual: CostEstimate,
  authorization: BudgetAuthorization,
  withinAuthorization: boolean,
  settledAt: string,
): VoiceCharge {
  return voiceChargeSchema.parse({
    schemaVersion: 1,
    transactionId,
    projectId,
    approvedScriptHash: scriptHash,
    providerId,
    reservationId: authorization.reservationId,
    idempotencyKey,
    authorizedMaxCny: authorization.maximumAmountCny,
    remainingAtAuthorizationCny: authorization.remainingAtAuthorizationCny,
    budgetScope,
    estimate,
    actual,
    status: withinAuthorization ? 'SETTLED_WITHIN_AUTHORIZATION' : 'SETTLED_OVER_AUTHORIZATION',
    settledAt,
  });
}

async function createMarker(
  io: VoiceArtifactIo,
  projectId: string,
  scriptHash: string,
  transactionId: string,
  authorizationReference: string,
  authorizationHash: string,
  committedAt: string,
  masterPath: string,
  timingsPath: string,
  reportPath: string,
  chargePath: string,
): Promise<VoiceCommitMarker> {
  return voiceCommitMarkerSchema.parse({
    schemaVersion: 1,
    transactionId,
    projectId,
    approvedScriptHash: scriptHash,
    masterHash: await sha256File(io, masterPath),
    timingsHash: await sha256File(io, timingsPath),
    reportHash: await sha256File(io, reportPath),
    chargeHash: await sha256File(io, chargePath),
    authorizationReference,
    authorizationHash,
    committedAt,
  });
}

function createReport(
  projectId: string,
  scriptHash: string,
  transactionId: string,
  synthesis: TtsResult,
  metadata: AudioMetadata,
  costCny: number,
  generatedAt: string,
): VoiceReport {
  return voiceReportSchema.parse({
    schemaVersion: 1,
    status: 'READY',
    projectId,
    transactionId,
    approvedScriptHash: scriptHash,
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
    costCny,
    generatedAt,
  });
}

function now(request: Pick<GenerateVoiceRequest, 'now'>): string {
  return (request.now ?? (() => new Date().toISOString()))();
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
  if (cost.providerId !== providerId) throw new Error(`TTS ${kind} cost must identify the selected provider`);
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

function assertAuthoritativeAudio(metadata: { sampleRateHz: number; formatName: string; codecName: string }): void {
  if (!isAuthoritativeAudio(metadata)) {
    throw new Error('authoritative voice master must be 48 kHz PCM WAV');
  }
}

function isAuthoritativeAudio(metadata: { sampleRateHz: number; formatName: string; codecName: string }): boolean {
  return metadata.sampleRateHz === 48_000
    && metadata.formatName.toLowerCase().split(',').includes('wav')
    && metadata.codecName.toLowerCase().startsWith('pcm_');
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
