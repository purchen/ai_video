import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { BudgetGuard } from '../../src/config';
import type { TtsAdapter, TtsRequest, TtsResult } from '../../src/providers/contracts';
import { ProviderRegistry } from '../../src/providers/registry';
import { createManualVoicePackage, importManualVoice, JianyingManualTtsAdapter, readManualVoicePackage } from '../../src/providers/tts/manual';
import { OpenAiTtsAdapter } from '../../src/providers/tts/openai';
import { scriptNarrationText } from '../../src/script/narration';
import { ProjectStore } from '../../src/store/project-store';
import {
  nodeVoiceArtifactIo,
  type VoiceArtifactIo,
} from '../../src/voice/artifacts';
import type { AudioProbe } from '../../src/voice/probe-audio';
import {
  cleanupVoiceArtifacts,
  generateVoice,
  readCommittedVoice,
  readVoiceAttemptAudit,
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
    expect(provider.requests.every((request) => request.idempotencyKey.includes(context.attemptId))).toBe(true);
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
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
    expect(await transactionDirectories(context.store)).toEqual([]);
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
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
  });

  it('rejects person-b provider output for a person-a authorization without READY publication', async () => {
    const context = await voiceContext();
    const provider = directProvider({ resultOverride: { voiceId: 'person-b' } });

    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
      voice: { voiceId: 'person-a', kind: 'cloned', authorization: cloneAuthorization('person-a') },
    })).rejects.toThrow('TTS result does not match selected provider and voice authorization');
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
  });
});

describe('generateVoice settlement and publication transaction', () => {
  it('rejects a direct attempt colliding with an existing non-owned transaction', async () => {
    const context = await voiceContext();
    const directory = join(context.store.root, 'voice', 'transactions', context.attemptId);
    await nodeVoiceArtifactIo.mkdir(directory);
    await writeFile(join(directory, 'master.wav'), 'manual committed bytes');
    const provider = directProvider();
    await expect(generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) }))
      .rejects.toThrow('voice attempt already exists');
    expect(provider.calls).toEqual([]);
    expect(await readFile(join(directory, 'master.wav'), 'utf8')).toBe('manual committed bytes');
  });

  it.each([
    ['direct', false], ['manual', false], ['direct', true], ['manual', true],
  ] as const)('excludes concurrent same-attempt %s callers (uppercase alias: %s) before mutable audit reads', async (caller, uppercaseAlias) => {
    const context = await voiceContext();
    if (uppercaseAlias) context.attemptId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    await createManualVoicePackage(context);
    const provider = directProvider();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const estimate = provider.adapter.estimate.bind(provider.adapter);
    let estimates = 0;
    provider.adapter.estimate = async (request) => {
      if (++estimates === 1) { entered(); await blocked; }
      return estimate(request);
    };
    const request = { ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) };
    const winner = generateVoice(request);
    await started;
    let conversions = 0;
    const competingId = uppercaseAlias ? context.attemptId.toUpperCase() : context.attemptId;
    const competing = caller === 'direct' ? generateVoice({ ...request, attemptId: competingId }) : importManualVoice({ ...context,
      attemptId: competingId,
      audioPath: 'unused.m4a',
      authorization: { schemaVersion: 1, sourceKind: 'jianying-synthetic', authorization: 'synthetic',
        voiceKind: 'synthetic', voiceId: 'narrator', syntheticIdentifier: 'jianying:narrator',
        authorizedBy: 'editor', authorizedAt: now, consentReference: 'synthetic://narrator' },
      converter: { convertToWav48k: async (_input, output) => { conversions++; await writeFile(output, 'manual bytes'); } },
    });
    const loser = await competing.then(() => 'accepted', (error: Error) => error.message);
    release();
    await winner;
    expect(loser).toBe('voice attempt is already active');
    expect(conversions).toBe(0);
    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
    const committed = await readCommittedVoice(context.store, context.probe);
    expect(await readFile(committed.masterPath, 'utf8')).toBe('fixture pcm wav');
  });

  it('canonicalizes an uppercase attempt across provider source, paths, audit, and retry', async () => {
    const context = await voiceContext();
    const attemptId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const provider = directProvider();
    const request = { ...context, attemptId: attemptId.toUpperCase(), registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) };
    const result = await generateVoice(request);
    expect(result).toMatchObject({ status: 'READY', report: { transactionId: attemptId } });
    const idempotencyKey = `voice:topic-001:${context.approvedScript.scriptHash}:${attemptId}`;
    expect(provider.requests.length).toBeGreaterThan(0);
    for (const source of provider.requests) {
      expect(source.idempotencyKey).toBe(idempotencyKey);
      expect(source.outputPath).toBe(join(context.store.root, 'voice', 'transactions', attemptId, 'master.tmp.wav'));
    }
    expect(await transactionDirectories(context.store)).toEqual([attemptId]);
    expect(await readdir(join(context.store.root, 'voice', 'audit'))).toEqual([attemptId]);
    const auditReadPaths: string[] = [];
    const audit = await readVoiceAttemptAudit(context.store, attemptId.toUpperCase(), {
      ...nodeVoiceArtifactIo,
      readFile: async (path) => { auditReadPaths.push(path); return nodeVoiceArtifactIo.readFile(path); },
    });
    expect(auditReadPaths).toContain(join(context.store.root, 'voice', 'audit', attemptId, 'attempt.json'));
    expect(audit).toMatchObject({
      attempt: { attemptId, transactionId: attemptId, idempotencyKey },
      reservation: { attemptId, idempotencyKey },
      settlement: { attemptId },
      charge: { transactionId: attemptId, reservationId: attemptId, idempotencyKey },
      result: { attemptId, transactionId: attemptId, marker: { transactionId: attemptId } },
    });
    await generateVoice({ ...request, attemptId });
    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
    expect(context.budgetGuard.spentCny()).toBe(0.45);
    const committed = await readCommittedVoice(context.store, context.probe);
    expect(committed.timings.transactionId).toBe(attemptId);
    expect(committed.charge.reservationId).toBe(attemptId);
  });

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
    const committed = await readCommittedVoice(context.store, context.probe);
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
    expect(() => voiceChargeSchema.parse({
      ...committed.charge,
      authorizedMaxCny: 20,
      remainingAtAuthorizationCny: 20,
      actual: { ...committed.charge.actual, amount: 20 },
      status: 'SETTLED_WITHIN_AUTHORIZATION',
    })).toThrow('authorized maximum must equal the audited estimate');
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
    const charge = (await readVoiceAttemptAudit(context.store, context.attemptId)).charge;
    expect(voiceChargeSchema.parse(charge)).toMatchObject({
      schemaVersion: 1,
      estimate: { amount: 1 },
      actual: { amount: 20 },
      authorizedMaxCny: 1,
      status: 'SETTLED_OVER_AUTHORIZATION',
    });
    expect((await readVoiceAttemptAudit(context.store, context.attemptId)).attempt.status).toBe('OVER_AUTHORIZATION');
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
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
      await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
      const transactions = await transactionDirectories(context.store);
      if (stage === 'marker') expect(transactions).toEqual([context.attemptId]);
      else expect(transactions).toEqual([]);
    },
  );

  it('keeps the old READY marker readable after a later transaction fails', async () => {
    const context = await voiceContext();
    await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]) });
    const previous = await readCommittedVoice(context.store, context.probe);

    await expect(generateVoice({
      ...context,
      attemptId: '00000000-0000-4000-8000-000000000022',
      registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]),
      artifactIo: failingIo('report'),
    })).rejects.toThrow('injected report failure');
    expect((await readCommittedVoice(context.store, context.probe)).report.transactionId)
      .toBe(previous.report.transactionId);
  });

  it('recovers a paid marker failure with the same attempt without a second provider call', async () => {
    const context = await voiceContext();
    const provider = directProvider();
    await expect(generateVoice({
      ...context,
      registry: ProviderRegistry.fromTtsAdapters([provider.adapter]),
      artifactIo: failingIo('marker'),
    })).rejects.toThrow('injected marker failure');
    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
    expect((await readVoiceAttemptAudit(context.store, context.attemptId)).attempt.status).toBe('RECOVERABLE');

    await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) });

    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
    await expect(readCommittedVoice(context.store, context.probe)).resolves.toMatchObject({ report: { status: 'READY' } });
  });

  it('blocks an ambiguous retry after provider invocation without a persisted result', async () => {
    const context = await voiceContext();
    const provider = directProvider({ synthesizeError: new Error('connection lost after request') });
    await expect(generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) }))
      .rejects.toThrow('connection lost after request');
    await expect(generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) }))
      .rejects.toThrow('voice attempt requires manual recovery before another paid call');
    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
    expect((await readVoiceAttemptAudit(context.store, context.attemptId)).attempt.status)
      .toBe('BLOCKED_MANUAL_RECOVERY');
  });

  it('treats a corrupt persisted attempt as blocking instead of a new payable attempt', async () => {
    const context = await voiceContext();
    const provider = directProvider({ synthesizeError: new Error('connection lost after request') });
    await expect(generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) }))
      .rejects.toThrow('connection lost after request');
    await writeFile(
      join(context.store.root, 'voice', 'audit', context.attemptId, 'attempt.json'),
      '{"corrupt":true}\n',
      'utf8',
    );

    await expect(generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) }))
      .rejects.toThrow();
    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
  });

  it.each(['master.wav', 'word-timings.json', 'voice-report.json', 'charge.json'] as const)(
    'rejects a committed transaction after %s bytes are tampered',
    async (artifactName) => {
      const context = await voiceContext();
      await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]) });
      const committed = await readCommittedVoice(context.store, context.probe);
      const artifactPath = join(
        context.store.root,
        'voice',
        'transactions',
        committed.report.transactionId,
        artifactName,
      );
      const original = await readFile(artifactPath);
      await writeFile(artifactPath, Buffer.concat([original, Buffer.from('tampered')]));
      await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow(
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
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
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
    await expect(readCommittedVoice(context.store, context.probe)).rejects.toThrow('voice publication is not committed');
  });

  it('re-probes committed master and rejects metadata that disagrees with its report', async () => {
    const context = await voiceContext();
    await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]) });
    let probeCalls = 0;
    const disagreeingProbe: AudioProbe = {
      probe: async () => {
        probeCalls += 1;
        return {
          durationMs: 90_000,
          sampleRateHz: 48_000,
          channels: 1,
          integratedLufs: -16,
          formatName: 'mp3',
          codecName: 'mp3',
        };
      },
    };
    await expect(readCommittedVoice(context.store, disagreeingProbe)).rejects.toThrow(
      'voice publication commit does not match its artifacts',
    );
    expect(probeCalls).toBe(1);
  });

  it('cleans stale sensitive staging without deleting the current committed version', async () => {
    const context = await voiceContext();
    await generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]) });
    const stale = join(context.store.root, 'voice', 'transactions', '00000000-0000-4000-8000-000000000099');
    await nodeVoiceArtifactIo.mkdir(stale);
    await nodeVoiceArtifactIo.writeFile(join(stale, 'master.wav'), 'sensitive stale bytes');
    await cleanupVoiceArtifacts(context.store, { keepRecentCommitted: 1 });
    await expect(access(stale)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readCommittedVoice(context.store, context.probe)).resolves.toMatchObject({ report: { status: 'READY' } });
  });

  it('retains result-backed recovery when attempt status predates result persistence', async () => {
    const context = await voiceContext();
    const provider = directProvider();
    const request = { ...context, registry: ProviderRegistry.fromTtsAdapters([provider.adapter]) };
    await expect(generateVoice({ ...request, artifactIo: failingIo('marker') })).rejects.toThrow();
    const path = join(context.store.root, 'voice', 'audit', context.attemptId, 'attempt.json');
    const attempt = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...attempt, status: 'PROVIDER_CALL_STARTED' }));
    await cleanupVoiceArtifacts(context.store, { keepRecentCommitted: 0 });
    await generateVoice(request);
    expect(provider.calls.filter((call) => call === 'synthesize')).toHaveLength(1);
    expect(await readFile((await readCommittedVoice(context.store, context.probe)).masterPath, 'utf8')).toBe('fixture pcm wav');
  });

  it.each(['malformed', 'unreadable'] as const)('fails cleanup closed on %s first audit before deleting unscanned recovery', async (failure) => {
    const context = await voiceContext();
    await expect(generateVoice({ ...context, registry: ProviderRegistry.fromTtsAdapters([directProvider().adapter]), artifactIo: failingIo('marker') }))
      .rejects.toThrow();
    const brokenId = '00000000-0000-4000-8000-000000000000';
    const brokenDirectory = join(context.store.root, 'voice', 'audit', brokenId);
    await nodeVoiceArtifactIo.mkdir(brokenDirectory);
    await writeFile(join(brokenDirectory, 'attempt.json'), '{');
    const io: VoiceArtifactIo = { ...nodeVoiceArtifactIo,
      readdir: async (path) => path.endsWith('audit') ? [brokenId, context.attemptId] : nodeVoiceArtifactIo.readdir(path),
      readFile: async (path) => {
        if (failure === 'unreadable' && path.includes(brokenId)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return nodeVoiceArtifactIo.readFile(path);
      },
    };
    await expect(cleanupVoiceArtifacts(context.store, { keepRecentCommitted: 0 }, io)).rejects.toThrow();
    const master = join(context.store.root, 'voice', 'transactions', context.attemptId, 'master.wav');
    expect(await readFile(master, 'utf8')).toBe('fixture pcm wav');
    await expect(readVoiceAttemptAudit(context.store, context.attemptId)).resolves.toMatchObject({ attempt: { status: 'RECOVERABLE' } });
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
    attemptId: '00000000-0000-4000-8000-000000000021',
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
  synthesizeError?: Error;
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
      if (options.synthesizeError) throw options.synthesizeError;
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
    idempotencyKey: 'voice:topic-001:test-attempt',
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

async function transactionDirectories(store: ProjectStore): Promise<string[]> {
  try {
    return (await readdir(join(store.root, 'voice', 'transactions'))).sort();
  } catch {
    return [];
  }
}
