import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { scriptNarrationText } from '../../src/script/narration';
import { BudgetGuard } from '../../src/config';
import { ProviderRegistry } from '../../src/providers/registry';
import { ProjectStore } from '../../src/store/project-store';
import {
  createManualVoicePackage,
  importManualVoice,
  manualAudioAuthorizationSchema,
  manualVoicePackageMarkerSchema,
  manualVoicePackageSchema,
  readManualVoicePackage,
  type ManualAudioAuthorization,
} from '../../src/providers/tts/manual';
import {
  nodeVoiceArtifactIo,
  type VoiceArtifactIo,
} from '../../src/voice/artifacts';
import {
  createFfmpegAudioConverter,
  createFfprobeAudioProbe,
  type AudioConverter,
  type AudioProbe,
} from '../../src/voice/probe-audio';
import { generateVoice, readCommittedVoice, voiceReportSchema, wordTimingsSchema } from '../../src/voice/generate-voice';
import { approvedFixture, now, persistDurableApproval } from './fixtures';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('transactional manual voice package', () => {
  it('rejects reused manual attempt before conversion without changing committed bytes', async () => {
    const context = await manualContext();
    const request = { ...context, authorization: syntheticAuthorization() };
    await importManualVoice(request);
    const previous = await readCommittedVoice(context.store, context.probe);
    const bytes = await readFile(previous.masterPath);
    let conversions = 0;
    await expect(importManualVoice({ ...request, converter: {
      convertToWav48k: async () => { conversions++; throw new Error('converter executed'); },
    } })).rejects.toThrow('voice attempt already exists');
    expect(conversions).toBe(0);
    expect(await readFile((await readCommittedVoice(context.store, context.probe)).masterPath)).toEqual(bytes);
  });

  it('excludes direct callers while a manual conversion owns the same attempt', async () => {
    const context = await manualContext();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const winner = importManualVoice({ ...context, authorization: syntheticAuthorization(), converter: {
      convertToWav48k: async (input, output) => {
        entered(); await blocked;
        await context.converter.convertToWav48k(input, output);
      },
    } });
    await started;
    const loser = await generateVoice({ ...context, registry: ProviderRegistry.detect({}),
      budgetGuard: new BudgetGuard({ limitCny: 5, spentCny: 0, dryRun: false }),
    }).then(() => 'accepted', () => 'rejected');
    release();
    await winner;
    expect(loser).toBe('rejected');
    expect(await readFile((await readCommittedVoice(context.store, context.probe)).masterPath, 'utf8')).toBe('converted 48000');
  });

  it('rejects package creation without official durable approval before writes', async () => {
    const context = await manualContext({ durable: false, createPackage: false });

    await expect(createManualVoicePackage({
      store: context.store,
      requestedScriptHash: approvedFixture('-forged').scriptHash,
      now: () => now,
    })).rejects.toThrow('script approval is not committed');
    await expect(access(join(context.store.root, 'voice'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits JSON and byte-identical text with a marker written last', async () => {
    const context = await manualContext({ createPackage: false });
    const manualPackage = await createManualVoicePackage({
      store: context.store,
      requestedScriptHash: context.approvedScript.scriptHash,
      now: () => now,
    });
    const committed = await readManualVoicePackage(context.store);
    const marker = manualVoicePackageMarkerSchema.parse(JSON.parse(
      await readFile(join(context.store.root, 'voice', 'manual-current.json'), 'utf8'),
    ));

    expect(manualVoicePackageSchema.parse(committed.package)).toEqual(manualPackage);
    expect(committed.text).toBe(scriptNarrationText(context.approvedScript.script));
    expect(marker.transactionId).toBe(manualPackage.transactionId);
  });

  it('rejects a tampered TXT even when package JSON is unchanged', async () => {
    const context = await manualContext();
    const committed = await readManualVoicePackage(context.store);
    await writeFile(
      join(context.store.root, 'voice', 'manual-packages', committed.package.transactionId, 'narration.txt'),
      `${committed.text}\n篡改`,
      'utf8',
    );
    await expect(readManualVoicePackage(context.store)).rejects.toThrow(
      'manual voice package commit does not match JSON and text artifacts',
    );
  });

  it.each(['text', 'marker'] as const)('does not expose a package when %s publication fails', async (stage) => {
    const context = await manualContext({ createPackage: false });
    await expect(createManualVoicePackage({
      store: context.store,
      requestedScriptHash: context.approvedScript.scriptHash,
      now: () => now,
      artifactIo: failingPackageIo(stage),
    })).rejects.toThrow(`injected package ${stage} failure`);
    await expect(readManualVoicePackage(context.store)).rejects.toThrow('manual voice package is not committed');
  });

  it('keeps the old package readable after a second-write failure', async () => {
    const context = await manualContext();
    const previous = await readManualVoicePackage(context.store);
    await expect(createManualVoicePackage({
      store: context.store,
      requestedScriptHash: context.approvedScript.scriptHash,
      now: () => now,
      artifactIo: failingPackageIo('text'),
    })).rejects.toThrow('injected package text failure');
    expect((await readManualVoicePackage(context.store)).package.transactionId).toBe(previous.package.transactionId);
  });

  it('rejects an old package marker after the durable approved script changes', async () => {
    const context = await manualContext();
    await persistDurableApproval(context.store, approvedFixture('-new'));
    await expect(readManualVoicePackage(context.store)).rejects.toThrow(
      'manual voice package marker does not match durable approved script',
    );
  });
});

describe('authorized manual voice import', () => {
  it.each([
    ['Jianying source with user authorization', {
      ...userAuthorization(), sourceKind: 'jianying-synthetic', voiceKind: 'cloned',
    }],
    ['cloned source with synthetic authorization', {
      ...syntheticAuthorization(), sourceKind: 'cloned', voiceKind: 'cloned',
    }],
    ['cloned source with similar-person voice kind', {
      ...userAuthorization(), sourceKind: 'cloned', voiceKind: 'similar-real-person',
    }],
    ['similar-person source with cloned voice kind', {
      ...similarAuthorization(), voiceKind: 'cloned',
    }],
    ['cloned source without owner', {
      ...userAuthorization(), owner: undefined,
    }],
  ] as const)('schema rejects contradictory rights: %s', (_label, record) => {
    expect(() => manualAudioAuthorizationSchema.parse(record)).toThrow();
  });

  it('rejects import against an empty store before conversion or artifact writes', async () => {
    const context = await manualContext({ durable: false, createPackage: false });
    await expect(importManualVoice({
      ...context,
      requestedScriptHash: approvedFixture('-forged').scriptHash,
      authorization: syntheticAuthorization(),
    })).rejects.toThrow('script approval is not committed');
    expect(context.convertCalls).toBe(0);
    await expect(access(join(context.store.root, 'voice'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects missing audio rights before conversion', async () => {
    const context = await manualContext();
    await expect(importManualVoice({ ...context, authorization: undefined })).rejects.toThrow(
      'manual audio authorization is required',
    );
    expect(context.convertCalls).toBe(0);
  });

  it('rejects a real-person source falsely labeled as synthetic rights', async () => {
    const context = await manualContext();
    await expect(importManualVoice({
      ...context,
      authorization: { ...syntheticAuthorization(), sourceKind: 'cloned' } as unknown as ManualAudioAuthorization,
    })).rejects.toThrow();
    expect(context.convertCalls).toBe(0);
  });

  it('rejects package/current approval mismatch before conversion', async () => {
    const context = await manualContext();
    const replacement = await persistDurableApproval(context.store, approvedFixture('-new'));
    await expect(importManualVoice({
      ...context,
      requestedScriptHash: replacement.scriptHash,
      authorization: userAuthorization(),
    })).rejects.toThrow('manual voice package marker does not match durable approved script');
    expect(context.convertCalls).toBe(0);
  });

  it.each([55_000, 130_000])('accepts inclusive duration boundary %i ms', async (durationMs) => {
    const context = await manualContext({ durationMs });
    const result = await importManualVoice({ ...context, authorization: syntheticAuthorization() });
    expect(result.report.durationMs).toBe(durationMs);
  });

  it.each([54_999, 130_001])('rejects duration outside the interval: %i ms', async (durationMs) => {
    const context = await manualContext({ durationMs });
    await expect(importManualVoice({ ...context, authorization: syntheticAuthorization() })).rejects.toThrow(
      'manual voice duration must be between 55 and 130 seconds',
    );
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
  });

  it('commits a 48 kHz PCM WAV with explicit Jianying synthetic rights', async () => {
    const context = await manualContext();
    const rights = manualAudioAuthorizationSchema.parse(syntheticAuthorization());
    await importManualVoice({ ...context, authorization: rights });
    const committed = await readCommittedVoice(context.store, context.probe);

    expect(context.convertedSampleRate).toBe(48_000);
    expect(voiceReportSchema.parse(committed.report)).toMatchObject({
      schemaVersion: 1,
      projectId: 'topic-001',
      providerId: 'jianying-manual',
      authorization: 'synthetic',
      authorizationReference: rights.consentReference,
      voiceId: rights.voiceId,
      formatName: 'wav',
      codecName: 'pcm_s16le',
      sampleRateHz: 48_000,
    });
    expect(wordTimingsSchema.parse(committed.timings)).toMatchObject({
      schemaVersion: 1,
      projectId: 'topic-001',
      approvedScriptHash: context.approvedScript.scriptHash,
      transactionId: committed.report.transactionId,
      mode: 'fallback-empty',
      words: [],
    });
    expect(await readFile(committed.masterPath, 'utf8')).toBe('converted 48000');
  });

  it('preserves external real-person owner consent in the committed report', async () => {
    const context = await manualContext();
    const rights = manualAudioAuthorizationSchema.parse(userAuthorization());
    await importManualVoice({ ...context, authorization: rights });
    const committed = await readCommittedVoice(context.store, context.probe);
    expect(committed.report).toMatchObject({
      providerId: 'external-manual',
      voiceId: 'person-a',
      voiceKind: 'cloned',
      authorization: 'user-authorized',
      authorizationReference: rights.consentReference,
    });
    expect(committed.report.authorizationHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['format', { formatName: 'mp3', codecName: 'mp3' }],
    ['codec', { formatName: 'wav', codecName: 'aac' }],
    ['sample rate', { formatName: 'wav', codecName: 'pcm_s16le', sampleRateHz: 44_100 }],
  ] as const)('rejects invalid converted %s before READY', async (_label, metadataOverride) => {
    const context = await manualContext({ metadataOverride });
    await expect(importManualVoice({ ...context, authorization: syntheticAuthorization() })).rejects.toThrow(
      'authoritative voice master must be 48 kHz PCM WAV',
    );
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
  });

  it('keeps an old committed manual voice readable when a later conversion fails', async () => {
    const previousContext = await manualContext();
    await importManualVoice({ ...previousContext, authorization: syntheticAuthorization() });
    const previous = await readCommittedVoice(previousContext.store, previousContext.probe);
    const failingProbe: AudioProbe = { probe: async () => { throw new Error('converted wav is invalid'); } };
    await expect(importManualVoice({
      ...previousContext,
      attemptId: '00000000-0000-4000-8000-000000000032',
      probe: failingProbe,
      authorization: syntheticAuthorization(),
    })).rejects.toThrow('converted wav is invalid');
    expect((await readCommittedVoice(previousContext.store, previousContext.probe)).report.transactionId)
      .toBe(previous.report.transactionId);
  });

  it('does not commit READY when the first converted audio probe fails', async () => {
    const context = await manualContext({ probeError: new Error('converted wav is invalid') });
    await expect(importManualVoice({ ...context, authorization: syntheticAuthorization() })).rejects.toThrow(
      'converted wav is invalid',
    );
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
  });

  it('rejects PATH-based ffmpeg and ffprobe assumptions', () => {
    expect(() => createFfprobeAudioProbe('ffprobe')).toThrow(
      'ffprobe executable path must be explicit and absolute',
    );
    expect(() => createFfmpegAudioConverter('ffmpeg')).toThrow(
      'ffmpeg executable path must be explicit and absolute',
    );
  });
});

async function manualContext(options: {
  durable?: boolean;
  createPackage?: boolean;
  durationMs?: number;
  metadataOverride?: Partial<Awaited<ReturnType<AudioProbe['probe']>>>;
  probeError?: Error;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voice-manual-'));
  temporaryDirectories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  const approvedScript = approvedFixture();
  if (options.durable !== false) await persistDurableApproval(store, approvedScript);
  if (options.createPackage !== false && options.durable !== false) {
    await createManualVoicePackage({ store, requestedScriptHash: approvedScript.scriptHash, now: () => now });
  }
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
        sampleRateHz: 48_000,
        channels: 1,
        integratedLufs: -17,
        formatName: 'wav',
        codecName: 'pcm_s16le',
        ...options.metadataOverride,
      };
    },
  };
  return {
    approvedScript,
    attemptId: '00000000-0000-4000-8000-000000000031',
    requestedScriptHash: approvedScript.scriptHash,
    audioPath,
    store,
    converter,
    probe,
    now: () => now,
    get convertCalls() { return convertCalls; },
    get convertedSampleRate() { return convertedSampleRate; },
  };
}

function syntheticAuthorization() {
  return {
    schemaVersion: 1 as const,
    authorization: 'synthetic' as const,
    sourceKind: 'jianying-synthetic' as const,
    voiceKind: 'synthetic' as const,
    voiceId: 'jianying-narrator',
    syntheticIdentifier: 'jianying:builtin:jianying-narrator',
    authorizedBy: 'editor',
    authorizedAt: now,
    consentReference: 'synthetic://jianying/jianying-narrator',
  };
}

function userAuthorization() {
  return {
    schemaVersion: 1 as const,
    authorization: 'user-authorized' as const,
    sourceKind: 'cloned' as const,
    voiceKind: 'cloned' as const,
    voiceId: 'person-a',
    owner: 'Person A',
    authorizedBy: 'Person A',
    authorizedAt: now,
    consentReference: 'consent://person-a/manual-audio',
  };
}

function similarAuthorization() {
  return {
    schemaVersion: 1 as const,
    authorization: 'user-authorized' as const,
    sourceKind: 'similar-real-person' as const,
    voiceKind: 'similar-real-person' as const,
    voiceId: 'person-similar-a',
    owner: 'Person A',
    authorizedBy: 'Person A',
    authorizedAt: now,
    consentReference: 'consent://person-a/similar-voice',
  };
}

function failingPackageIo(stage: 'text' | 'marker'): VoiceArtifactIo {
  return {
    ...nodeVoiceArtifactIo,
    writeFile: async (path, data) => {
      if (stage === 'text' && String(path).replaceAll('\\', '/').endsWith('/narration.txt')) {
        throw new Error('injected package text failure');
      }
      await nodeVoiceArtifactIo.writeFile(path, data);
    },
    rename: async (from, to) => {
      if (stage === 'marker' && String(to).replaceAll('\\', '/').endsWith('/manual-current.json')) {
        throw new Error('injected package marker failure');
      }
      await nodeVoiceArtifactIo.rename(from, to);
    },
  };
}
