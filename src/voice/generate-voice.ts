import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { BudgetGuard } from '../config';
import type { CostEstimate, TtsRequest } from '../providers/contracts';
import type { ProviderRegistry } from '../providers/registry';
import {
  createManualVoicePackage,
  writeManualVoicePackage,
  type ManualVoicePackage,
} from '../providers/tts/manual';
import { approvedScriptSchema, type ApprovedScript } from '../review/approve';
import { scriptNarrationText } from '../script/narration';
import type { ProjectStore } from '../store/project-store';
import { boundedVoicePath, ensureVoiceDirectory, writeVoiceJson } from './artifacts';
import { audioMetadataSchema, type AudioProbe } from './probe-audio';
import {
  voiceAuthorizationSchema,
  voiceReportSchema,
  wordTimingsSchema,
  type VoiceAuthorization,
  type VoiceReport,
} from './schemas';

export { voiceAuthorizationSchema, voiceReportSchema, wordTimingsSchema } from './schemas';
export type { VoiceAuthorization, VoiceReport, WordTimings } from './schemas';

export interface VoiceSelection {
  voiceId: string;
  kind: 'synthetic' | 'cloned' | 'similar-real-person';
  authorization?: VoiceAuthorization;
}

export interface GenerateVoiceRequest {
  approvedScript: ApprovedScript;
  requestedScriptHash?: string;
  registry: ProviderRegistry;
  budgetGuard: BudgetGuard;
  store: ProjectStore;
  probe: AudioProbe;
  voice?: VoiceSelection;
  now?: () => string;
}

export type GenerateVoiceResult =
  | { status: 'READY'; report: VoiceReport }
  | { status: 'MANUAL_AUDIO_REQUIRED'; package: ManualVoicePackage };

export async function generateVoice(request: GenerateVoiceRequest): Promise<GenerateVoiceResult> {
  const approvedScript = approvedScriptSchema.parse(request.approvedScript);
  const requestedHash = request.requestedScriptHash ?? approvedScript.scriptHash;
  if (requestedHash !== approvedScript.scriptHash) {
    throw new Error('voice request does not match approved script hash');
  }

  const voice = validateVoiceSelection(request.voice ?? { voiceId: 'alloy', kind: 'synthetic' });
  const text = scriptNarrationText(approvedScript.script);
  const directory = await ensureVoiceDirectory(request.store);
  const temporaryAudio = join(directory, `.master.${randomUUID()}.tmp.wav`);
  const ttsRequest: TtsRequest = {
    approvedScriptHash: approvedScript.scriptHash,
    text,
    voiceId: voice.voiceId,
    outputPath: temporaryAudio,
  };
  const adapter = await request.registry.selectAvailableTts(ttsRequest);
  if (adapter.mode === 'manual') {
    const manualPackage = createManualVoicePackage(approvedScript, (request.now ?? (() => new Date().toISOString()))());
    await writeManualVoicePackage(request.store, manualPackage);
    return { status: 'MANUAL_AUDIO_REQUIRED', package: manualPackage };
  }

  try {
    const estimate = await adapter.estimate(ttsRequest);
    assertProviderCost(estimate, adapter.id, 'estimate');
    request.budgetGuard.assertAllowed(estimate);
    const synthesis = await adapter.synthesize(ttsRequest);
    if (synthesis.audioPath !== temporaryAudio) {
      throw new Error('TTS provider must write only to the requested temporary output path');
    }
    assertProviderCost(synthesis.cost, synthesis.providerId, 'actual');
    const metadata = audioMetadataSchema.parse(await request.probe.probe(temporaryAudio));
    const authorization = voice.kind === 'synthetic' ? 'synthetic' : 'user-authorized';
    if (synthesis.authorization !== authorization) {
      throw new Error('TTS provider authorization does not match the validated voice selection');
    }
    const timings = wordTimingsSchema.parse(synthesis.wordTimings?.length
      ? { schemaVersion: 1, mode: 'provider', words: synthesis.wordTimings }
      : { schemaVersion: 1, mode: 'fallback-empty', words: [] });
    const report = voiceReportSchema.parse({
      schemaVersion: 1,
      status: 'READY',
      approvedScriptHash: approvedScript.scriptHash,
      providerId: synthesis.providerId,
      model: synthesis.model,
      voiceId: synthesis.voiceId,
      authorization,
      durationMs: metadata.durationMs,
      sampleRateHz: metadata.sampleRateHz,
      channels: metadata.channels,
      integratedLufs: metadata.integratedLufs,
      costCny: synthesis.cost.amount,
      generatedAt: (request.now ?? (() => new Date().toISOString()))(),
    });

    await rename(temporaryAudio, boundedVoicePath(request.store, 'master.wav'));
    await writeVoiceJson(request.store, 'word-timings.json', wordTimingsSchema, timings);
    await writeVoiceJson(request.store, 'voice-report.json', voiceReportSchema, report);
    request.budgetGuard.recordActual(synthesis.cost);
    return { status: 'READY', report };
  } finally {
    await unlink(temporaryAudio).catch(() => undefined);
  }
}

function assertProviderCost(
  cost: CostEstimate,
  expectedProviderId: string,
  kind: 'estimate' | 'actual',
): void {
  if (cost.currency !== 'CNY' || !Number.isFinite(cost.amount) || cost.amount < 0) {
    throw new Error(`TTS ${kind} cost must be a finite, non-negative CNY value`);
  }
  if (cost.providerId !== expectedProviderId || !cost.basis.trim()) {
    throw new Error(`TTS ${kind} cost must identify its provider and audit basis`);
  }
}

function validateVoiceSelection(voice: VoiceSelection): VoiceSelection {
  if (!voice.voiceId.trim()) throw new Error('voiceId is required');
  if (voice.kind === 'synthetic') return voice;
  if (!voice.authorization) {
    throw new Error('voice authorization is required for cloned voices');
  }
  const authorization = voiceAuthorizationSchema.parse(voice.authorization);
  if (authorization.voiceId !== voice.voiceId || authorization.kind !== voice.kind) {
    throw new Error('voice authorization does not match the selected voice');
  }
  return { ...voice, authorization };
}
