import { expect, it } from 'vitest';
import { manualAudioAuthorizationSchema } from '../../src/providers/tts/manual';
import { now } from './fixtures';
import { prepared, probe } from '../workflow/fixtures';
import { createManualVoicePackage, importManualVoice } from '../../src/providers/tts/manual';
import { readApprovedScript } from '../../src/review/approve';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes } from '../../src/voice/artifacts';
import { readCommittedVoice, generateVoice } from '../../src/voice/generate-voice';
import { ProviderRegistry } from '../../src/providers/registry';
import { BudgetGuard } from '../../src/config';
it('accepts authorized original human recordings without mislabelling them cloned', () => {
  const rights = { schemaVersion: 1, sourceKind: 'original-human', voiceKind: 'original-human', authorization: 'user-authorized', voiceId: 'my-voice', owner: 'editor', authorizedBy: 'editor', authorizedAt: now, consentReference: 'signed-consent', sourceAudioHash: 'a'.repeat(64) };
  expect(manualAudioAuthorizationSchema.parse(rights).voiceKind).toBe('original-human');
  expect(manualAudioAuthorizationSchema.safeParse({ ...rights, owner: undefined }).success).toBe(false);
  expect(manualAudioAuthorizationSchema.safeParse({ ...rights, sourceAudioHash: undefined }).success).toBe(false);
  expect(manualAudioAuthorizationSchema.safeParse({ ...rights, voiceKind: 'cloned' }).success).toBe(false);
});
it('binds original-recording import to actual source bytes and persists its distinct kind', async () => {
  const f = await prepared();
  try {
    const approved = await readApprovedScript(f.store); await createManualVoicePackage({ store: f.store, requestedScriptHash: approved.scriptHash });
    const audioPath = join(f.parent, 'human.wav'); await writeFile(audioPath, 'human source bytes');
    const authorization = { schemaVersion: 1 as const, sourceKind: 'original-human' as const, voiceKind: 'original-human' as const, authorization: 'user-authorized' as const, voiceId: 'owner', owner: 'owner', authorizedBy: 'owner', authorizedAt: now, consentReference: 'signed', sourceAudioHash: 'a'.repeat(64) };
    const request = { store: f.store, requestedScriptHash: approved.scriptHash, attemptId: '00000000-0000-4000-8000-000000000042', audioPath, probe, authorization, converter: { convertToWav48k: async (path: string, output: string) => { await writeFile(output, await readFile(path)); } } };
    await expect(importManualVoice(request)).rejects.toThrow(/source audio hash/);
    const result = await importManualVoice({ ...request, authorization: { ...authorization, sourceAudioHash: sha256Bytes(await readFile(audioPath)) } });
    expect(result.report.voiceKind).toBe('original-human'); expect(result.report.authorization).toBe('user-authorized');
    const rightsPath = join(f.store.root, 'voice/transactions', request.attemptId, 'authorization.json');
    expect(JSON.parse(await readFile(rightsPath, 'utf8')).owner).toBe('owner');
    await writeFile(rightsPath, '{}');
    await expect(readCommittedVoice(f.store, probe)).rejects.toThrow(/commit/);
  } finally { await rm(f.parent, { force: true, recursive: true }); }
});

it.each([['cloned', 'manual'], ['cloned', 'direct'], ['similar-real-person', 'manual'], ['similar-real-person', 'direct']] as const)('persists and revalidates complete %s rights for %s voices', async (kind, mode) => {
    const f = await prepared();
    try {
      const approved = await readApprovedScript(f.store);
      const attemptId = '00000000-0000-4000-8000-000000000043';
      const base = { schemaVersion: 1 as const, voiceId: 'authorized-voice', owner: 'rights owner', authorizedBy: 'authorized agent', authorizedAt: now, consentReference: 'signed explicit permission' };
      const authorization = mode === 'manual' ? { ...base, sourceKind: kind, voiceKind: kind, authorization: 'user-authorized' as const } : { ...base, kind };
      if (mode === 'manual') {
        await createManualVoicePackage({ store: f.store, requestedScriptHash: approved.scriptHash });
        await importManualVoice({ store: f.store, requestedScriptHash: approved.scriptHash, attemptId, audioPath: 'offline input', probe,
          authorization: manualAudioAuthorizationSchema.parse(authorization), converter: { convertToWav48k: async (_, output) => { await writeFile(output, 'offline voice bytes'); } } });
      } else {
        const cost = { providerId: 'offline-authorized', currency: 'CNY' as const, amount: 0, basis: 'offline fixture' };
        const registry = ProviderRegistry.fromTtsAdapters([{ id: cost.providerId, mode: 'direct', supports: () => true, available: async () => true, estimate: async () => cost,
          synthesize: async request => { await writeFile(request.outputPath, 'offline voice bytes'); return { ...request, audioPath: request.outputPath, durationMs: 60000, providerId: cost.providerId, model: 'test', cost }; } }]);
        await generateVoice({ store: f.store, requestedScriptHash: approved.scriptHash, attemptId, probe, registry,
          budgetGuard: new BudgetGuard({ spentCny: 0, limitCny: 0, dryRun: false }), voice: { voiceId: base.voiceId, kind, authorization: { ...base, kind } } });
      }
      const path = join(f.store.root, 'voice/transactions', attemptId, 'authorization.json');
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(authorization);
      expect((await readCommittedVoice(f.store, probe)).report.voiceKind).toBe(kind);
      await writeFile(path, JSON.stringify({ ...authorization, owner: 'different owner' }));
      await expect(readCommittedVoice(f.store, probe)).rejects.toThrow(/commit/);
      await rm(path);
      await expect(readCommittedVoice(f.store, probe)).rejects.toThrow(/commit/);
    } finally { await rm(f.parent, { force: true, recursive: true }); }
});
