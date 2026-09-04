import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runQc } from '../../src/qc/run-qc';
import { production, probe, media } from '../workflow/fixtures';
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
  expect(report.errors.map(e => e.check)).toEqual(expect.arrayContaining(['manifest', 'topic-approval', 'script-approval', 'voice', 'assets', 'media']));
  expect(JSON.parse(await readFile(join(store.root, 'reports/qc.json'), 'utf8'))).toEqual(report);
  expect(report.schemaVersion).toBe(1);
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
