import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetGuard } from '../../src/config';
import type { TtsAdapter, TtsRequest, TtsResult } from '../../src/providers/contracts';
import { ProviderRegistry } from '../../src/providers/registry';
import { JianyingManualTtsAdapter, readManualVoicePackage } from '../../src/providers/tts/manual';
import { OpenAiTtsAdapter } from '../../src/providers/tts/openai';
import { scriptNarrationText } from '../../src/script/narration';
import { ProjectStore } from '../../src/store/project-store';
import {
  nodeVoiceArtifactIo,
  type VoiceArtifactIo,
} from '../../src/voice/artifacts';
import type { AudioProbe } from '../../src/voice/probe-audio';
import {
  generateVoice,
  readCommittedVoice,
  voiceChargeSchema,
  voiceReportSchema,
  wordTimingsSchema,
} from '../../src/voice/generate-voice';
import { approvedFixture, now, persistDurableApproval } from './fixtures';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('generateVoice durable and provider boundaries', () => {
  it('labels OpenAI actual cost as a configured calculation rather than a provider invoice', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openai-cost-'));
    temporaryDirectories.push(parent);
    const adapter = new OpenAiTtsAdapter({
      apiKey: 'test-key',
      fetch: async () => new Response(Buffer.from('offline wav fixture'), { status: 200 }),
    });
    const request = ttsRequestFixture(join(parent, 'output.wav'));

    const result = await adapter.synthesize(request);

    expect(result.cost.basis).toContain('configured calculation; not provider-reported invoice');
  });

  it('rejects a forged self-consistent in-memory hash when no durable approval exists', async () => {
    const context = await voiceContext({ durable: false });
    const forged = approvedFixture('-forged');
    const provider = directProvider();

    await expect(generateVoice({
      ...context,
      requestedScriptHash: forged.scriptHash,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('script approval is not committed');

    expect(provider.calls).toEqual([]);
    await expect(access(join(context.store.root, 'voice'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a request hash that differs from the official durable approval before provider calls', async () => {
    const context = await voiceContext();
    const provider = directProvider();

    await expect(generateVoice({
      ...context,
      requestedScriptHash: '0'.repeat(64),
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('voice request does not match approved script hash');

    expect(provider.calls).toEqual([]);
  });

  it('passes canonical durable narration and voice requirements to the provider unchanged', async () => {
    const context = await voiceContext();
    const provider = directProvider();

    await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) });

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.every((request) => request.text === scriptNarrationText(context.approvedScript.script))).toBe(true);
    expect(provider.requests.every((request) => request.voiceKind === 'synthetic')).toBe(true);
    expect(provider.requests.every((request) => request.authorization === 'synthetic')).toBe(true);
  });

  it('returns a committed Jianying package when no direct compatible TTS is available', async () => {
    const context = await voiceContext();

    const result = await generateVoice({ ...context, registry: ProviderRegistry.detect({}) });

    expect(result.status).toBe('MANUAL_AUDIO_REQUIRED');
    if (result.status !== 'MANUAL_AUDIO_REQUIRED') throw new Error('expected manual result');
    const committed = await readManualVoicePackage(context.store);
    expect(committed.package).toEqual(result.package);
    expect(committed.package.scriptHash).toBe(context.approvedScript.scriptHash);
    expect(committed.text).toBe(scriptNarrationText(context.approvedScript.script));
  });

  it('degrades when an OpenAI adapter has no API key without a network call', async () => {
    const context = await voiceContext();
    let fetchCalls = 0;
    const openAi = new OpenAiTtsAdapter({
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('network must not be called');
      },
    });

    const result = await generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([openAi, new JianyingManualTtsAdapter()]),
    });

    expect(result.status).toBe('MANUAL_AUDIO_REQUIRED');
    expect(fetchCalls).toBe(0);
  });

  it('makes zero paid synthesis calls and publishes no READY marker when budget rejects the estimate', async () => {
    const context = await voiceContext();
    const provider = directProvider();

    await expect(generateVoice({
      ...context,
      budgetGuard: new BudgetGuard({ limitCny: 0, spentCny: 0, dryRun: false }),
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('Paid call requires approval');

    expect(provider.calls).toEqual(['supports', 'available', 'estimate']);
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });

  it.each(['cloned', 'similar-real-person'] as const)(
    'blocks %s without a validated authorization before registry or budget work',
    async (kind) => {
      const context = await voiceContext();
      const provider = directProvider();
      await expect(generateVoice({
        ...context,
        registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
        voice: { voiceId: 'person-a', kind },
      })).rejects.toThrow('voice authorization is required for cloned voices');
      expect(provider.calls).toEqual([]);
    },
  );

  it('filters OpenAI synthetic capability before any paid call for an authorized cloned voice', async () => {
    const context = await voiceContext();
    let fetchCalls = 0;
    const openAi = new OpenAiTtsAdapter({
      apiKey: 'test-key',
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('incompatible provider must not be called');
      },
    });
    const result = await generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([openAi, new JianyingManualTtsAdapter()]),
      voice: { voiceId: 'person-a', kind: 'cloned', authorization: cloneAuthorization('person-a') },
    });
    expect(result.status).toBe('MANUAL_AUDIO_REQUIRED');
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ['providerId', { providerId: 'person-b-provider' }],
    ['voiceId', { voiceId: 'person-b' }],
    ['authorization', { authorization: 'user-authorized' }],
  ] as const)('rejects provider result %s mismatch without READY publication', async (_field, resultOverride) => {
    const context = await voiceContext();
    const provider = directProvider({ resultOverride });

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('TTS result does not match selected provider and voice authorization');
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });

  it('rejects person-b provider output for a person-a authorization without READY publication', async () => {
    const context = await voiceContext();
    const provider = directProvider({ resultOverride: { voiceId: 'person-b' } });

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
      voice: { voiceId: 'person-a', kind: 'cloned', authorization: cloneAuthorization('person-a') },
    })).rejects.toThrow('TTS result does not match selected provider and voice authorization');
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });
});

describe('generateVoice settlement and publication transaction', () => {
  it('settles an authorized charge before committing schema-bound READY artifacts', async () => {
    const context = await voiceContext();
    const provider = directProvider({
      wordTimings: [
        { word: '这件事', startMs: 0, endMs: 500 },
        { word: '改变', startMs: 500, endMs: 900 },
      ],
    });

    const result = await generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    });

    expect(result.status).toBe('READY');
    const committed = await readCommittedVoice(context.store);
    expect(voiceReportSchema.parse(committed.report)).toMatchObject({
      schemaVersion: 1,
      status: 'READY',
      projectId: 'topic-001',
      approvedScriptHash: context.approvedScript.scriptHash,
      authorization: 'synthetic',
      authorizationReference: 'synthetic:voice:alloy',
      sampleRateHz: 48_000,
      formatName: 'wav',
      codecName: 'pcm_s16le',
    });
    expect(wordTimingsSchema.parse(committed.timings)).toMatchObject({
      schemaVersion: 1,
      projectId: 'topic-001',
      approvedScriptHash: context.approvedScript.scriptHash,
      mode: 'provider',
    });
    expect(voiceChargeSchema.parse(committed.charge).status).toBe('SETTLED_WITHIN_AUTHORIZATION');
    expect(context.budgetGuard.spentCny()).toBe(0.45);
    expect(() => voiceChargeSchema.parse({
      ...committed.charge,
      actual: { ...committed.charge.actual, providerId: 'other-provider' },
    })).toThrow('charge providers must match the transaction provider');
    expect(() => voiceReportSchema.parse({
      ...committed.report,
      voiceKind: 'cloned',
      authorization: 'synthetic',
    })).toThrow('voice kind and authorization must agree');
  });

  it('records an incurred over-authorization actual charge but forbids READY', async () => {
    const context = await voiceContext({ budgetLimit: 1 });
    const provider = directProvider({ estimateAmount: 1, actualAmount: 20 });

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('actual TTS cost exceeds authorized amount');

    expect(context.budgetGuard.spentCny()).toBe(20);
    const charge = await onlyPersistedCharge(context.store);
    expect(voiceChargeSchema.parse(charge)).toMatchObject({
      schemaVersion: 1,
      estimate: { amount: 1 },
      actual: { amount: 20 },
      status: 'SETTLED_OVER_AUTHORIZATION',
    });
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });

  it.each(['master', 'timings', 'report', 'charge', 'marker'] as const)(
    'does not expose READY when %s publication fails',
    async (stage) => {
      const context = await voiceContext();
      const provider = directProvider();
      await expect(generateVoice({
        ...context,
        registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
        artifactIo: failingIo(stage),
      })).rejects.toThrow(`injected ${stage} failure`);
      await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
    },
  );

  it('does not reuse an old READY marker after a later transaction fails', async () => {
    const context = await voiceContext();
    await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]) });
    await expect(readCommittedVoice(context.store)).resolves.toMatchObject({ report: { status: 'READY' } });

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]),
      artifactIo: failingIo('report'),
    })).rejects.toThrow('injected report failure');
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });

  it.each(['master.wav', 'word-timings.json', 'voice-report.json', 'charge.json'] as const)(
    'rejects a committed transaction after %s bytes are tampered',
    async (artifactName) => {
      const context = await voiceContext();
      await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]) });
      const committed = await readCommittedVoice(context.store);
      const artifactPath = join(
        context.store.root,
        'voice',
        'transactions',
        committed.report.transactionId,
        artifactName,
      );
      const original = await readFile(artifactPath);
      await writeFile(artifactPath, Buffer.concat([original, Buffer.from('tampered')]));
      await expect(readCommittedVoice(context.store)).rejects.toThrow(
        'voice publication commit does not match its artifacts',
      );
    },
  );

  it.each([
    ['format', { formatName: 'mp3', codecName: 'mp3' }],
    ['codec', { formatName: 'wav', codecName: 'aac' }],
    ['sample rate', { formatName: 'wav', codecName: 'pcm_s16le', sampleRateHz: 44_100 }],
  ] as const)('rejects invalid direct master %s before READY', async (_label, metadataOverride) => {
    const context = await voiceContext({ metadataOverride });
    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]),
    })).rejects.toThrow('authoritative voice master must be 48 kHz PCM WAV');
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });

  it('rejects non-monotonic, overlapping, or out-of-duration word timings', async () => {
    const context = await voiceContext();
    const provider = directProvider({
      wordTimings: [
        { word: 'a', startMs: 100, endMs: 700 },
        { word: 'b', startMs: 600, endMs: 800 },
        { word: 'c', startMs: 90_000, endMs: 90_001 },
      ],
    });
    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('word timings must be monotonic, non-overlapping, and within voice duration');
    await expect(readCommittedVoice(context.store)).rejects.toThrow('voice publication is not committed');
  });
});

async function voiceContext(options: {
  durable?: boolean;
  budgetLimit?: number;
  metadataOverride?: Partial<Awaited<ReturnType<AudioProbe['probe']>>>;
} = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voice-generate-'));
  temporaryDirectories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  const approvedScript = approvedFixture();
  if (options.durable !== false) await persistDurableApproval(store, approvedScript);
  const probe: AudioProbe = {
    probe: async () => ({
      durationMs: 90_000,
      sampleRateHz: 48_000,
      channels: 1,
      integratedLufs: -16,
      formatName: 'wav',
      codecName: 'pcm_s16le',
      ...options.metadataOverride,
    }),
  };
  return {
    approvedScript,
    requestedScriptHash: approvedScript.scriptHash,
    store,
    budgetGuard: new BudgetGuard({ limitCny: options.budgetLimit ?? 5, spentCny: 0, dryRun: false }),
    probe,
    now: () => now,
  };
}

function directProvider(options: {
  estimateAmount?: number;
  actualAmount?: number;
  wordTimings?: TtsResult['wordTimings'];
  resultOverride?: Partial<TtsResult>;
  supported?: boolean;
} = {}): { adapter: TtsAdapter; calls: string[]; requests: TtsRequest[] } {
  const calls: string[] = [];
  const requests: TtsRequest[] = [];
  const adapter: TtsAdapter = {
    id: 'fake-direct',
    mode: 'direct',
    supports: (request) => {
      calls.push('supports');
      requests.push(request);
      return options.supported ?? true;
    },
    available: async () => {
      calls.push('available');
      return true;
    },
    estimate: async (request) => {
      calls.push('estimate');
      requests.push(request);
      return { providerId: 'fake-direct', currency: 'CNY', amount: options.estimateAmount ?? 0.5, basis: 'configured fixture estimate' };
    },
    synthesize: async (request) => {
      calls.push('synthesize');
      requests.push(request);
      await writeFile(request.outputPath, 'fixture pcm wav');
      return {
        audioPath: request.outputPath,
        durationMs: 90_000,
        providerId: 'fake-direct',
        model: 'fixture-model',
        voiceId: request.voiceId,
        voiceKind: request.voiceKind,
        authorization: request.authorization,
        authorizationReference: request.authorizationReference,
        authorizationHash: request.authorizationHash,
        cost: {
          providerId: 'fake-direct',
          currency: 'CNY',
          amount: options.actualAmount ?? 0.45,
          basis: 'provider-reported fixture charge',
        },
        wordTimings: options.wordTimings,
        ...options.resultOverride,
      };
    },
  };
  return { adapter, calls, requests };
}

function cloneAuthorization(voiceId: string) {
  return {
    schemaVersion: 1 as const,
    voiceId,
    kind: 'cloned' as const,
    authorizedBy: 'rights-owner',
    authorizedAt: now,
    consentReference: 'consent://person-a/2026-09-01',
  };
}

function ttsRequestFixture(outputPath: string): TtsRequest {
  return {
    approvedScriptHash: 'a'.repeat(64),
    text: '不访问真实网络的旁白',
    voiceId: 'alloy',
    voiceKind: 'synthetic',
    authorization: 'synthetic',
    authorizationReference: 'synthetic:voice:alloy',
    authorizationHash: 'b'.repeat(64),
    outputPath,
  };
}

function failingIo(stage: 'master' | 'timings' | 'report' | 'charge' | 'marker'): VoiceArtifactIo {
  return {
    ...nodeVoiceArtifactIo,
    writeFile: async (path, data) => {
      const normalized = String(path).replaceAll('\\', '/');
      if ((stage === 'timings' && normalized.endsWith('/word-timings.json'))
        || (stage === 'report' && normalized.endsWith('/voice-report.json'))
        || (stage === 'charge' && normalized.endsWith('/charge.json'))) {
        throw new Error(`injected ${stage} failure`);
      }
      await nodeVoiceArtifactIo.writeFile(path, data);
    },
    rename: async (from, to) => {
      const normalized = String(to).replaceAll('\\', '/');
      if ((stage === 'master' && normalized.endsWith('/master.wav'))
        || (stage === 'marker' && normalized.endsWith('/current.json'))) {
        throw new Error(`injected ${stage} failure`);
      }
      await nodeVoiceArtifactIo.rename(from, to);
    },
  };
}

async function onlyPersistedCharge(store: ProjectStore): Promise<unknown> {
  const root = join(store.root, 'voice', 'transactions');
  const transactions = await readdir(root);
  expect(transactions).toHaveLength(1);
  return JSON.parse(await readFile(join(root, transactions[0], 'charge.json'), 'utf8'));
}
