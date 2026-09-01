import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptNarrationText } from '../../src/script/narration';
import { ProjectStore } from '../../src/store/project-store';
import {
  createManualVoicePackage,
  importManualVoice,
  manualVoicePackageSchema,
} from '../../src/providers/tts/manual';
import {
  createFfmpegAudioConverter,
  createFfprobeAudioProbe,
  type AudioConverter,
  type AudioProbe,
} from '../../src/voice/probe-audio';
import { voiceReportSchema, wordTimingsSchema } from '../../src/voice/generate-voice';
import { approvedFixture } from './fixtures';

const temporaryDirectories: string[] = [];
const now = '2026-09-01T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('manual voice import', () => {
  it('rejects PATH-based ffmpeg and ffprobe assumptions', () => {
    expect(() => createFfprobeAudioProbe('ffprobe')).toThrow(
      'ffprobe executable path must be explicit and absolute',
    );
    expect(() => createFfmpegAudioConverter('ffmpeg')).toThrow(
      'ffmpeg executable path must be explicit and absolute',
    );
  });

  it('rejects a package hash that differs from the current approved script', async () => {
    const context = await manualContext();
    const manualPackage = { ...createManualVoicePackage(context.approvedScript, now), scriptHash: '0'.repeat(64) };

    await expect(importManualVoice({ ...context, package: manualPackage })).rejects.toThrow(
      'manual voice package does not match current approved script hash',
    );
    expect(context.convertCalls).toBe(0);
  });

  it('rejects package text or text hash not derived from the locked narration', async () => {
    const context = await manualContext();
    const original = createManualVoicePackage(context.approvedScript, now);

    await expect(importManualVoice({
      ...context,
      package: { ...original, text: `${original.text}\n改写` },
    })).rejects.toThrow('manual voice package text does not match locked narration');
    await expect(importManualVoice({
      ...context,
      package: { ...original, textHash: '0'.repeat(64) },
    })).rejects.toThrow('manual voice package text hash is invalid');
    expect(context.convertCalls).toBe(0);
  });

  it.each([55_000, 130_000])('accepts the inclusive duration boundary %i ms', async (durationMs) => {
    const context = await manualContext({ durationMs });
    const result = await importManualVoice({
      ...context,
      package: createManualVoicePackage(context.approvedScript, now),
    });

    expect(result.report.durationMs).toBe(durationMs);
  });

  it.each([54_999, 130_001])('rejects duration outside the allowed interval: %i ms', async (durationMs) => {
    const context = await manualContext({ durationMs });

    await expect(importManualVoice({
      ...context,
      package: createManualVoicePackage(context.approvedScript, now),
    })).rejects.toThrow('manual voice duration must be between 55 and 130 seconds');
    await expect(access(join(context.store.root, 'voice', 'master.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a probed 48 kHz WAV with schema-versioned report and fallback timings', async () => {
    const context = await manualContext();
    const result = await importManualVoice({
      ...context,
      package: createManualVoicePackage(context.approvedScript, now),
    });

    expect(result.status).toBe('READY');
    expect(context.convertedSampleRate).toBe(48_000);
    expect(voiceReportSchema.parse(result.report)).toMatchObject({
      schemaVersion: 1,
      providerId: 'external-manual',
      authorization: 'user-authorized',
      sampleRateHz: 48_000,
    });
    expect(manualVoicePackageSchema.parse(createManualVoicePackage(context.approvedScript, now)).schemaVersion).toBe(1);
    const timings = JSON.parse(await readFile(join(context.store.root, 'voice', 'word-timings.json'), 'utf8'));
    expect(wordTimingsSchema.parse(timings)).toEqual({ schemaVersion: 1, mode: 'fallback-empty', words: [] });
    expect(await readFile(join(context.store.root, 'voice', 'master.wav'), 'utf8')).toBe('converted 48000');
  });

  it('does not publish master or READY report when converted audio probe fails', async () => {
    const context = await manualContext({ probeError: new Error('converted wav is invalid') });

    await expect(importManualVoice({
      ...context,
      package: createManualVoicePackage(context.approvedScript, now),
    })).rejects.toThrow('converted wav is invalid');

    await expect(access(join(context.store.root, 'voice', 'master.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(context.store.root, 'voice', 'voice-report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a converted output that is not 48 kHz', async () => {
    const context = await manualContext({ sampleRateHz: 44_100 });

    await expect(importManualVoice({
      ...context,
      package: createManualVoicePackage(context.approvedScript, now),
    })).rejects.toThrow('converted manual voice must be a 48 kHz WAV');
  });

  it('derives package text byte-for-byte from the locked narration', () => {
    const approvedScript = approvedFixture();
    const manualPackage = createManualVoicePackage(approvedScript, now);

    expect(manualPackage.text).toBe(scriptNarrationText(approvedScript.script));
  });
});

async function manualContext(options: {
  durationMs?: number;
  sampleRateHz?: number;
  probeError?: Error;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voice-manual-'));
  temporaryDirectories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  const audioPath = join(parent, 'external-audio.m4a');
  await writeFile(audioPath, 'external audio');
  let convertCalls = 0;
  let convertedSampleRate: number | undefined;
  const converter: AudioConverter = {
    convertToWav48k: async (_inputPath, outputPath) => {
      convertCalls += 1;
      convertedSampleRate = 48_000;
      await writeFile(outputPath, 'converted 48000');
    },
  };
  const probe: AudioProbe = {
    probe: async () => {
      if (options.probeError) throw options.probeError;
      return {
        durationMs: options.durationMs ?? 90_000,
        sampleRateHz: options.sampleRateHz ?? 48_000,
        channels: 1,
        integratedLufs: -17,
      };
    },
  };
  return {
    approvedScript: approvedFixture(),
    package: undefined as never,
    audioPath,
    store,
    converter,
    probe,
    now: () => now,
    get convertCalls() { return convertCalls; },
    get convertedSampleRate() { return convertedSampleRate; },
  };
}
