import { createHash, randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { CostEstimate, ManualTtsAdapter, TtsRequest, TtsResult } from '../contracts';
import { approvedScriptSchema, type ApprovedScript } from '../../review/approve';
import { scriptNarrationText } from '../../script/narration';
import type { ProjectStore } from '../../store/project-store';
import { boundedVoicePath, ensureVoiceDirectory, writeVoiceJson, writeVoiceText } from '../../voice/artifacts';
import { audioMetadataSchema, type AudioConverter, type AudioProbe } from '../../voice/probe-audio';
import {
  voiceReportSchema,
  wordTimingsSchema,
  type VoiceReport,
} from '../../voice/schemas';

export const manualVoicePackageSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  scriptHash: z.string().regex(/^[a-f0-9]{64}$/),
  text: z.string().min(1),
  textHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(),
});

export type ManualVoicePackage = z.infer<typeof manualVoicePackageSchema>;

export class JianyingManualTtsAdapter implements ManualTtsAdapter {
  readonly id = 'jianying-manual' as const;
  readonly mode = 'manual' as const;

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

export function createManualVoicePackage(
  approvedScriptInput: ApprovedScript,
  createdAt = new Date().toISOString(),
): ManualVoicePackage {
  const approvedScript = approvedScriptSchema.parse(approvedScriptInput);
  const text = scriptNarrationText(approvedScript.script);
  return manualVoicePackageSchema.parse({
    schemaVersion: 1,
    projectId: approvedScript.script.projectId,
    scriptHash: approvedScript.scriptHash,
    text,
    textHash: hashText(text),
    createdAt,
  });
}

export async function writeManualVoicePackage(
  store: ProjectStore,
  manualPackageInput: ManualVoicePackage,
): Promise<void> {
  const manualPackage = manualVoicePackageSchema.parse(manualPackageInput);
  await writeVoiceJson(store, 'manual-voice-package.json', manualVoicePackageSchema, manualPackage);
  await writeVoiceText(store, 'manual-voice.txt', manualPackage.text);
}

export interface ImportManualVoiceRequest {
  approvedScript: ApprovedScript;
  package: ManualVoicePackage;
  audioPath: string;
  store: ProjectStore;
  converter: AudioConverter;
  probe: AudioProbe;
  now?: () => string;
}

export interface ReadyVoiceResult {
  status: 'READY';
  report: VoiceReport;
}

export async function importManualVoice(request: ImportManualVoiceRequest): Promise<ReadyVoiceResult> {
  const approvedScript = approvedScriptSchema.parse(request.approvedScript);
  const manualPackage = manualVoicePackageSchema.parse(request.package);
  const canonicalText = scriptNarrationText(approvedScript.script);
  if (manualPackage.scriptHash !== approvedScript.scriptHash) {
    throw new Error('manual voice package does not match current approved script hash');
  }
  if (manualPackage.projectId !== approvedScript.script.projectId) {
    throw new Error('manual voice package does not match current approved script project');
  }
  if (manualPackage.text !== canonicalText) {
    throw new Error('manual voice package text does not match locked narration');
  }
  if (manualPackage.textHash !== hashText(canonicalText)) {
    throw new Error('manual voice package text hash is invalid');
  }

  const directory = await ensureVoiceDirectory(request.store);
  const temporaryWav = join(directory, `.master.${randomUUID()}.tmp.wav`);
  try {
    await request.converter.convertToWav48k(request.audioPath, temporaryWav);
    const metadata = audioMetadataSchema.parse(await request.probe.probe(temporaryWav));
    if (metadata.sampleRateHz !== 48_000) throw new Error('converted manual voice must be a 48 kHz WAV');
    if (metadata.durationMs < 55_000 || metadata.durationMs > 130_000) {
      throw new Error('manual voice duration must be between 55 and 130 seconds');
    }

    const timings = wordTimingsSchema.parse({ schemaVersion: 1, mode: 'fallback-empty', words: [] });
    const report = voiceReportSchema.parse({
      schemaVersion: 1,
      status: 'READY',
      approvedScriptHash: approvedScript.scriptHash,
      providerId: 'external-manual',
      model: 'user-provided-audio',
      voiceId: 'external-audio',
      authorization: 'user-authorized',
      durationMs: metadata.durationMs,
      sampleRateHz: metadata.sampleRateHz,
      channels: metadata.channels,
      integratedLufs: metadata.integratedLufs,
      costCny: 0,
      generatedAt: (request.now ?? (() => new Date().toISOString()))(),
    });

    await rename(temporaryWav, boundedVoicePath(request.store, 'master.wav'));
    await writeVoiceJson(request.store, 'word-timings.json', wordTimingsSchema, timings);
    await writeVoiceJson(request.store, 'voice-report.json', voiceReportSchema, report);
    return { status: 'READY', report };
  } finally {
    await unlink(temporaryWav).catch(() => undefined);
  }
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
