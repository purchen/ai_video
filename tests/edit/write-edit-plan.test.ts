import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ProjectStore } from '../../src/store/project-store';
import { createManualVoicePackage, importManualVoice } from '../../src/providers/tts/manual';
import { writeEditPlan } from '../../src/edit/build-edit-plan';
import { fixture } from './fixtures';
import { persistDurableApproval, now } from '../voice/fixtures';
import { hashScript, hashCanonicalJson } from '../../src/script/hash-script';
import { projectManifestSchema } from '../../src/domain/schemas';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const probe = { probe: async () => ({ durationMs: 90000, sampleRateHz: 48000, channels: 1, integratedLufs: -17, formatName: 'wav', codecName: 'pcm_s16le' }) };
async function context() {
  const parent = await mkdtemp(join(tmpdir(), 'edit-plan-'));
  directories.push(parent);
  const store = await ProjectStore.create(parent, 'topic-001');
  return { store, parent, ...fixture() };
}
it('writes a validated plan from formal approval and immutable committed voice, ignoring flat audio', async () => {
  const c = await context();
  c.approvedScript.script.sentences[3].sourceIds = ['comment-1'];
  c.approvedScript.script.sentences[5].sourceIds = ['comment-1', 'official-1'];
  c.approvedScript.scriptHash = hashScript(c.approvedScript.script);
  await persistDurableApproval(c.store, c.approvedScript);
  // Extend the durable test fixture's source snapshot, retaining its real reader integrity checks.
  const manifest = await c.store.readJson('project.json', projectManifestSchema);
  manifest.sources.push({ ...manifest.sources[0], id: 'comment-1', sourceType: 'comment-sample', evidenceWeight: 'low' });
  await c.store.writeJson('project.json', projectManifestSchema, manifest);
  const commitPath = join(c.store.root, 'script-approval.commit.json');
  const commit = JSON.parse(await readFile(commitPath, 'utf8'));
  await writeFile(commitPath, JSON.stringify({ ...commit, projectSnapshot: manifest, projectHash: hashCanonicalJson(manifest) }));
  await createManualVoicePackage({ store: c.store, requestedScriptHash: c.approvedScript.scriptHash });
  const audioPath = join(c.parent, 'input.wav');
  await writeFile(audioPath, 'input audio');
  await importManualVoice({ store: c.store, requestedScriptHash: c.approvedScript.scriptHash, audioPath,
    attemptId: c.voiceReport.transactionId, probe, converter: { convertToWav48k: async (_input, output) => { await writeFile(output, 'immutable audio'); } },
    authorization: { schemaVersion: 1, authorization: 'synthetic', sourceKind: 'jianying-synthetic', voiceKind: 'synthetic', voiceId: 'builtin', syntheticIdentifier: 'jianying:builtin', authorizedBy: 'editor', authorizedAt: now, consentReference: 'synthetic://builtin' } });
  await writeFile(join(c.store.root, 'voice', 'master.wav'), 'stale flat audio');
  const assets = { ...c.assets, assets: [
    { schemaVersion: 1 as const, id: 'clip-1', kind: 'clip' as const, path: 'assets/clip.mp4', sentenceIds: ['sentence-mechanism'], permission: 'permitted' as const, permissionRecord: { schemaVersion: 1 as const, assetId: 'clip-1', reference: 'licenses/clip.txt' } },
    { schemaVersion: 1 as const, id: 'abstract-1', kind: 'generated-abstract' as const, path: 'assets/abstract.png', sentenceIds: ['sentence-judgment'], permission: 'permitted' as const, permissionRecord: { schemaVersion: 1 as const, assetId: 'abstract-1', reference: 'licenses/abstract.txt' }, generationRecord: { schemaVersion: 1 as const, assetId: 'abstract-1', provider: 'offline', reference: 'generation/abstract.json' } },
  ] };
  const plan = await writeEditPlan(c.store, probe, assets);
  expect(plan.voice.masterPath).toBe('voice/transactions/00000000-0000-4000-8000-000000000003/master.wav');
  const saved = JSON.parse(await readFile(join(c.store.root, 'edit-plan.json'), 'utf8'));
  expect(saved).toEqual(plan);
  expect(saved.scenes[3]).toMatchObject({ publicQuestionLabel: '公众疑问（非事实证据）', visual: { kind: 'authorized-clip' } });
  expect(saved.scenes[5]).toMatchObject({ publicQuestionLabel: '公众疑问（非事实证据）', visual: { kind: 'ai-abstract' } });
  await expect(writeEditPlan(c.store, probe, { ...c.assets, projectId: 'other' })).rejects.toThrow();
  expect(JSON.parse(await readFile(join(c.store.root, 'edit-plan.json'), 'utf8'))).toEqual(plan);
});
it('refuses missing formal approval or uncommitted voice without writing a plan', async () => {
  const c = await context();
  await expect(writeEditPlan(c.store, probe, c.assets)).rejects.toThrow(/approval/);
  await persistDurableApproval(c.store, c.approvedScript);
  await expect(writeEditPlan(c.store, probe, c.assets)).rejects.toThrow(/voice/);
  await expect(access(join(c.store.root, 'edit-plan.json'))).rejects.toThrow();
});
