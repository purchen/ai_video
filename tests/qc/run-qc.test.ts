import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runQc } from '../../src/qc/run-qc';
import { production, selectedProduction, probe, media } from '../workflow/fixtures';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() { const f = await production(); roots.push(f.parent); await mkdir(join(f.store.root, 'output')); await writeFile(join(f.store.root, 'output/final.mp4'), 'offline video double'); return f; }
it('aggregates missing fact evidence, uncommitted approvals, permission, voice and media failures into a versioned report', async () => {
  const { store } = await setup();
  const project = JSON.parse(await readFile(join(store.root, 'project.json'), 'utf8')); project.sources = [];
  await writeFile(join(store.root, 'project.json'), JSON.stringify(project));
  await rm(join(store.root, 'topic-approval.commit.json'));
  await writeFile(join(store.root, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: 'topic-001', assets: [{ schemaVersion: 1, id: 'bad', kind: 'clip', path: 'bad.mp4', sentenceIds: [], permission: 'unknown' }] }));
  const report = await runQc(store.root, { probe, probeMedia: async () => ({ streams: [], format: { duration: 60 } }) });
  expect(report.status).toBe('FAILED_QC');
  expect(report.errors.map(e => e.check)).toEqual(expect.arrayContaining(['manifest', 'topic-approval', 'script-approval', 'voice', 'media']));
  expect(JSON.parse(await readFile(join(store.root, 'reports/qc.json'), 'utf8'))).toEqual(report);
  expect(report.schemaVersion).toBe(1);
});
it('allows an unused unknown asset after safe edit-plan fallback', async () => {
  const { store } = await setup(); await writeFile(join(store.root, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, projectId: 'topic-001', assets: [{ schemaVersion: 1, id: 'unknown', kind: 'clip', path: 'missing.mp4', sentenceIds: [], permission: 'unknown' }] }));
  expect((await runQc(store.root, { probe, probeMedia: async () => media })).status).toBe('QC_PASSED');
});
it('hashes every selected media and permission/generation record byte, and detects missing selected permission', async () => {
  const f = await selectedProduction(); roots.push(f.parent); await mkdir(join(f.store.root, 'output')); await writeFile(join(f.store.root, 'output/final.mp4'), 'offline video');
  const before = await runQc(f.store.root, { probe, probeMedia: async () => media });
  for (const path of ['clip.mp4', 'abstract.png', 'music.wav', 'clip-license.txt', 'generation.json']) expect(before.inputHashes[path]).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(f.store.root, 'clip.mp4'), 'new clip');
  const changed = await runQc(f.store.root, { probe, probeMedia: async () => media });
  expect(changed.inputHashes['clip.mp4']).not.toBe(before.inputHashes['clip.mp4']);
  await rm(join(f.store.root, 'clip-license.txt'));
  expect((await runQc(f.store.root, { probe, probeMedia: async () => media })).status).toBe('FAILED_QC');
});
it('rejects an edit-plan hash mismatch and invalid geometry', async () => {
  const { store } = await setup(); const path = join(store.root, 'edit-plan.json'); const plan = JSON.parse(await readFile(path, 'utf8')); plan.approvedScriptHash = 'a'.repeat(64); await writeFile(path, JSON.stringify(plan));
  const report = await runQc(store.root, { probe, probeMedia: async () => ({ ...media, streams: [{ ...media.streams[0], width: 720 }, media.streams[1]] }) });
  expect(report.errors.map(e => e.check)).toEqual(expect.arrayContaining(['edit-plan', 'media']));
});
it('rejects voice marker script substitution', async () => {
  const { store } = await setup(); const path = join(store.root, 'voice/current.json'); const marker = JSON.parse(await readFile(path, 'utf8')); marker.approvedScriptHash = 'b'.repeat(64); await writeFile(path, JSON.stringify(marker));
  expect((await runQc(store.root, { probe, probeMedia: async () => media })).errors.some(e => e.check === 'voice')).toBe(true);
});
it('passes valid cross-module artifacts using immutable voice paths', async () => {
  const { store } = await setup(); const report = await runQc(store.root, { probe, probeMedia: async () => media });
  expect(report.status).toBe('QC_PASSED'); expect(report.errors).toEqual([]);
  expect(report.inputHashes['output/final.mp4']).toMatch(/^[a-f0-9]{64}$/);
});
