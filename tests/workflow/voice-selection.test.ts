import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry';
import type { TtsRequest } from '../../src/providers/contracts';
import { generateVoice, readCommittedVoice } from '../../src/voice/generate-voice';
import { BudgetGuard } from '../../src/config';
import { readApprovedScript } from '../../src/review/approve';
import { runStage } from '../../src/workflow/run-stage';
import { prepared, probe } from './fixtures';

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
