import { expect, it } from 'vitest';
import { manualAudioAuthorizationSchema } from '../../src/providers/tts/manual';
import { now } from './fixtures';
import { prepared, probe } from '../workflow/fixtures';
import { createManualVoicePackage, importManualVoice } from '../../src/providers/tts/manual';
import { readApprovedScript } from '../../src/review/approve';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Bytes } from '../../src/voice/artifacts';
import { readCommittedVoice } from '../../src/voice/generate-voice';
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
