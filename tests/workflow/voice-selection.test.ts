import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry';
import type { TtsRequest } from '../../src/providers/contracts';
import { generateVoice, readCommittedVoice } from '../../src/voice/generate-voice';
import { BudgetGuard } from '../../src/config';
import { readApprovedScript } from '../../src/review/approve';
import { runStage } from '../../src/workflow/run-stage';
import { prepared, probe } from './fixtures';
import { resolveManagedMediaTools } from '../../src/render/media-tools';

function adapter(fail = false) {
  const requests: TtsRequest[] = [];
  const cost = { providerId: 'offline-selection-test', currency: 'CNY' as const, amount: 0, basis: 'test double; no network' };
  const registry = ProviderRegistry.fromTtsAdapters([{
    id: cost.providerId, mode: 'direct', supports: () => true, available: async () => true,
    estimate: async request => { requests.push(request); return cost; },
    synthesize: async request => {
      requests.push(request);
      if (fail) throw new Error('ambiguous provider failure');
      await writeFile(request.outputPath, 'unit-test audio double');
      return { ...request, audioPath: request.outputPath, durationMs: 60000, providerId: cost.providerId, model: 'selection-test', cost };
    },
  }]);
  return { requests, registry, probe, limitCny: 0, consent: { actor: 'fixture-editor', reference: 'offline-only' } };
}

describe('workflow synthetic voice identity', () => {
  it('converts preserved 22.05 kHz speech with default managed tools, without injected converter', async () => {
    const { store } = await prepared();
    const speech = await readFile('tests/fixtures/mvp-project/speech.wav');
    const cost = { providerId: 'offline-default-conversion', currency: 'CNY' as const, amount: 0, basis: 'saved speech replay; no network' };
    let calls = 0;
    const registry = ProviderRegistry.fromTtsAdapters([{
      id: cost.providerId, mode: 'direct', supports: () => true, available: async () => true, estimate: async () => cost,
      synthesize: async request => { calls++; await writeFile(request.outputPath, speech); return { ...request, audioPath: request.outputPath, durationMs: 109000, providerId: cost.providerId, model: 'offline-Windows-Huihui-replay', cost }; },
    }]);
    expect(await runStage(store.root, 'voice', { registry, voiceId: 'Microsoft Huihui Desktop', limitCny: 0, consent: { actor: 'editor', reference: 'offline regression' } })).toBe('VOICE_READY');
    expect((await readCommittedVoice(store, (await resolveManagedMediaTools()).probe)).report.sampleRateHz).toBe(48000);
    expect(calls).toBe(1);
  }, 30000);

  it('allows a budget-only rejection to retry after funding without an orphan audit directory', async () => {
    const { store } = await prepared();
    let calls = 0;
    const cost = { providerId: 'offline-budget-retry', currency: 'CNY' as const, amount: 1, basis: 'offline budget fixture' };
    const registry = ProviderRegistry.fromTtsAdapters([{
      id: cost.providerId, mode: 'direct', supports: () => true, available: async () => true, estimate: async () => cost,
      synthesize: async request => { calls++; await writeFile(request.outputPath, 'test audio double'); return { ...request, audioPath: request.outputPath, durationMs: 60000, providerId: cost.providerId, model: 'test', cost }; },
    }]);
    const deps = { registry, probe, consent: { actor: 'editor', reference: 'offline regression' } };
    expect(await runStage(store.root, 'voice', { ...deps, limitCny: 0 })).toBe('BLOCKED_PROVIDER');
    expect(calls).toBe(0);
    expect(await readdir(join(store.root, 'voice/audit')).catch(() => [])).toEqual([]);
    expect(await runStage(store.root, 'voice', { ...deps, limitCny: 5 })).toBe('VOICE_READY');
    expect(calls).toBe(1);
  });
  it('refuses to recover an existing lower-level voice transaction under another identity', async () => {
    const { store } = await prepared();
    const deps = adapter();
    await generateVoice({ store, registry: deps.registry, probe, budgetGuard: new BudgetGuard({ spentCny: 0, limitCny: 0, dryRun: false }),
      attemptId: '00000000-0000-4000-8000-000000000010', requestedScriptHash: (await readApprovedScript(store)).scriptHash,
      voice: { voiceId: 'Microsoft Huihui Desktop', kind: 'synthetic' } });
    await expect(runStage(store.root, 'voice', { ...deps, voiceId: 'different-voice' })).rejects.toThrow('voice selection changed');
    expect((await readCommittedVoice(store, probe)).report.voiceId).toBe('Microsoft Huihui Desktop');
    expect(deps.requests).toHaveLength(2);
  });
  it.each(['Microsoft Huihui Desktop', 'alloy'])('persists the selected %s identity through preflight, synthesis and official reader', async voiceId => {
    const { store } = await prepared();
    const deps = adapter();
    expect(await runStage(store.root, 'voice', { ...deps, ...(voiceId === 'alloy' ? {} : { voiceId }) })).toBe('VOICE_READY');
    expect(deps.requests.every(request => request.voiceId === voiceId && request.authorizationReference === `synthetic:voice:${voiceId}`)).toBe(true);
    expect((await readCommittedVoice(store, probe)).report.voiceId).toBe(voiceId);
  });

  it('refuses another voice under a completed cached attempt without replacing the committed voice', async () => {
    const { store } = await prepared();
    const deps = adapter();
    expect(await runStage(store.root, 'voice', { ...deps, voiceId: 'Microsoft Huihui Desktop' })).toBe('VOICE_READY');
    const before = await readFile(join(store.root, 'voice/current.json'), 'utf8');
    await expect(runStage(store.root, 'voice', { ...deps, voiceId: 'different-voice' })).rejects.toThrow('voice selection changed');
    expect(await readFile(join(store.root, 'voice/current.json'), 'utf8')).toBe(before);
    expect(deps.requests).toHaveLength(3);
  });

  it('keeps an ambiguous attempt bound to its original voice across retries', async () => {
    const { store } = await prepared();
    const deps = adapter(true);
    expect(await runStage(store.root, 'voice', { ...deps, voiceId: 'Microsoft Huihui Desktop' })).toBe('BLOCKED_PROVIDER');
    const before = await readFile(join(store.root, 'workflow-journal.json'), 'utf8');
    await expect(runStage(store.root, 'voice', { ...deps, voiceId: 'different-voice' })).rejects.toThrow('voice selection changed');
    expect(await readFile(join(store.root, 'workflow-journal.json'), 'utf8')).toBe(before);
    expect(deps.requests).toHaveLength(3);
  });
});
