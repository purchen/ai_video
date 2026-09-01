import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetGuard } from '../../src/config';
import type { TtsAdapter, TtsRequest, TtsResult } from '../../src/providers/contracts';
import { ProviderRegistry } from '../../src/providers/registry';
import { JianyingManualTtsAdapter } from '../../src/providers/tts/manual';
import { OpenAiTtsAdapter } from '../../src/providers/tts/openai';
import { scriptNarrationText } from '../../src/script/narration';
import { ProjectStore } from '../../src/store/project-store';
import type { AudioProbe } from '../../src/voice/probe-audio';
import {
  generateVoice,
  voiceReportSchema,
  wordTimingsSchema,
} from '../../src/voice/generate-voice';
import { approvedFixture } from './fixtures';

const temporaryDirectories: string[] = [];
const now = '2026-09-01T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('generateVoice', () => {
  it('rejects synthesis when the request hash differs from the approved script', async () => {
    const context = await voiceContext();
    const provider = directProvider();

    await expect(generateVoice({
      ...context,
      requestedScriptHash: '0'.repeat(64),
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('voice request does not match approved script hash');
    expect(provider.calls).toEqual([]);
  });

  it('passes the canonical locked narration text to the provider without rewriting it', async () => {
    const context = await voiceContext();
    const provider = directProvider();

    const result = await generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    });

    expect(result.status).toBe('READY');
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((request) => request.text === scriptNarrationText(context.approvedScript.script))).toBe(true);
  });

  it('uses auditable estimate, budget, synthesis, probe, publication, then actual-cost recording order', async () => {
    const order: string[] = [];
    const context = await voiceContext({ order });
    const provider = directProvider({ order });
    class TrackingBudgetGuard extends BudgetGuard {
      override assertAllowed(estimate: Parameters<BudgetGuard['assertAllowed']>[0]): void {
        order.push('budget');
        super.assertAllowed(estimate);
      }

      override recordActual(cost: Parameters<BudgetGuard['recordActual']>[0]): void {
        order.push('record');
        expect(existsSync(join(context.store.root, 'voice', 'master.wav'))).toBe(true);
        expect(existsSync(join(context.store.root, 'voice', 'word-timings.json'))).toBe(true);
        expect(existsSync(join(context.store.root, 'voice', 'voice-report.json'))).toBe(true);
        super.recordActual(cost);
      }
    }
    const budgetGuard = new TrackingBudgetGuard({ limitCny: 5, spentCny: 0, dryRun: false });

    const result = await generateVoice({
      ...context,
      budgetGuard,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    });

    expect(result.status).toBe('READY');
    expect(order).toEqual([
      'estimate',
      'budget',
      'synthesize',
      'probe',
      'record',
    ]);
    expect(budgetGuard.spentCny()).toBe(0.45);
  });

  it('returns and writes a Jianying package when no direct TTS is available', async () => {
    const context = await voiceContext();

    const result = await generateVoice({
      ...context,
      registry: ProviderRegistry.detect({}),
    });

    expect(result).toMatchObject({
      status: 'MANUAL_AUDIO_REQUIRED',
      package: {
        schemaVersion: 1,
        scriptHash: context.approvedScript.scriptHash,
        text: scriptNarrationText(context.approvedScript.script),
      },
    });
    const json = JSON.parse(await readFile(join(context.store.root, 'voice', 'manual-voice-package.json'), 'utf8'));
    expect(json.schemaVersion).toBe(1);
    expect(await readFile(join(context.store.root, 'voice', 'manual-voice.txt'), 'utf8'))
      .toBe(scriptNarrationText(context.approvedScript.script));
  });

  it('degrades when an OpenAI adapter has no API key without calling the network', async () => {
    const context = await voiceContext();
    let fetchCalls = 0;
    const openAi = new OpenAiTtsAdapter({
      fetch: async () => {
        fetchCalls += 1;
        throw new Error('network must not be called');
      },
    });
    const registry = ProviderRegistry.fromTtsAdapters([openAi, new JianyingManualTtsAdapter()]);

    const result = await generateVoice({ ...context, registry });

    expect(await openAi.available()).toBe(false);
    expect(result.status).toBe('MANUAL_AUDIO_REQUIRED');
    expect(fetchCalls).toBe(0);
  });

  it('makes zero synthesis calls and publishes zero successful artifacts when budget is rejected', async () => {
    const context = await voiceContext();
    const provider = directProvider();

    await expect(generateVoice({
      ...context,
      budgetGuard: new BudgetGuard({ limitCny: 0, spentCny: 0, dryRun: false }),
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('Paid call requires approval');

    expect(provider.calls).toEqual(['available', 'estimate']);
    await expect(access(join(context.store.root, 'voice', 'master.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(context.store.root, 'voice', 'voice-report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['cloned', 'similar-real-person'] as const)(
    'blocks %s voices without validated authorization before budget or provider calls',
    async (kind) => {
    const context = await voiceContext();
    const provider = directProvider();
    let budgetCalls = 0;
    class TrackingBudgetGuard extends BudgetGuard {
      override assertAllowed(estimate: Parameters<BudgetGuard['assertAllowed']>[0]): void {
        budgetCalls += 1;
        super.assertAllowed(estimate);
      }
    }

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
      budgetGuard: new TrackingBudgetGuard({ limitCny: 5, spentCny: 0, dryRun: false }),
      voice: { voiceId: 'person-a', kind },
    })).rejects.toThrow('voice authorization is required for cloned voices');

    expect(provider.calls).toEqual([]);
    expect(budgetCalls).toBe(0);
    },
  );

  it('publishes schema-versioned artifacts and synthetic authorization after a successful probe', async () => {
    const context = await voiceContext();
    const provider = directProvider({
      wordTimings: [{ word: '这件事', startMs: 0, endMs: 500 }],
    });

    const result = await generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    });

    expect(result.status).toBe('READY');
    if (result.status !== 'READY') throw new Error('expected READY');
    expect(voiceReportSchema.parse(result.report)).toMatchObject({
      schemaVersion: 1,
      status: 'READY',
      authorization: 'synthetic',
      sampleRateHz: 48_000,
    });
    const persistedReport = JSON.parse(await readFile(join(context.store.root, 'voice', 'voice-report.json'), 'utf8'));
    const persistedTimings = JSON.parse(await readFile(join(context.store.root, 'voice', 'word-timings.json'), 'utf8'));
    expect(voiceReportSchema.parse(persistedReport)).toEqual(result.report);
    expect(wordTimingsSchema.parse(persistedTimings)).toMatchObject({ schemaVersion: 1, mode: 'provider' });
  });

  it('does not publish master or READY report when probing synthesized audio fails', async () => {
    const context = await voiceContext({ probeError: new Error('invalid wav') });
    const provider = directProvider();

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('invalid wav');

    await expect(access(join(context.store.root, 'voice', 'master.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(context.store.root, 'voice', 'voice-report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates actual provider cost before publishing READY artifacts', async () => {
    const context = await voiceContext();
    const provider = directProvider({ actualCurrency: 'USD' });

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
    })).rejects.toThrow('TTS actual cost must be a finite, non-negative CNY value');

    await expect(access(join(context.store.root, 'voice', 'master.wav'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(context.store.root, 'voice', 'voice-report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function voiceContext(options: { order?: string[]; probeError?: Error } = {}) {
  const parent = await mkdtemp(join(tmpdir(), 'voice-generate-'));
  temporaryDirectories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  const approvedScript = approvedFixture();
  const probe: AudioProbe = {
    probe: async () => {
      options.order?.push('probe');
      if (options.probeError) throw options.probeError;
      return { durationMs: 90_000, sampleRateHz: 48_000, channels: 1, integratedLufs: -16 };
    },
  };
  return {
    approvedScript,
    requestedScriptHash: approvedScript.scriptHash,
    store,
    budgetGuard: new BudgetGuard({ limitCny: 5, spentCny: 0, dryRun: false }),
    probe,
    now: () => now,
  };
}

function directProvider(options: {
  order?: string[];
  wordTimings?: TtsResult['wordTimings'];
  actualCurrency?: string;
} = {}): { adapter: TtsAdapter; calls: string[]; requests: TtsRequest[] } {
  const calls: string[] = [];
  const requests: TtsRequest[] = [];
  const adapter: TtsAdapter = {
    id: 'fake-direct',
    mode: 'direct',
    available: async () => {
      calls.push('available');
      return true;
    },
    estimate: async (request) => {
      calls.push('estimate');
      options.order?.push('estimate');
      requests.push(request);
      return { providerId: 'fake-direct', currency: 'CNY', amount: 0.5, basis: 'fixture' };
    },
    synthesize: async (request) => {
      calls.push('synthesize');
      options.order?.push('synthesize');
      requests.push(request);
      await writeFile(request.outputPath, 'fixture wav');
      return {
        audioPath: request.outputPath,
        durationMs: 90_000,
        providerId: 'fake-direct',
        model: 'fixture-model',
        voiceId: request.voiceId,
        authorization: 'synthetic',
        cost: {
          providerId: 'fake-direct',
          currency: options.actualCurrency ?? 'CNY',
          amount: 0.45,
          basis: 'actual fixture',
        } as TtsResult['cost'],
        wordTimings: options.wordTimings,
      };
    },
  };
  return { adapter, calls, requests };
}
