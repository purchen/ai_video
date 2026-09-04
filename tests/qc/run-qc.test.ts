import { readFile, rm, writeFile, mkdir, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runQc } from '../../src/qc/run-qc';
import { production, selectedProduction, probe, media, analyzeAudio } from '../workflow/fixtures';
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
  expect((await runQc(store.root, { probe, probeMedia: async () => media, analyzeAudio })).status).toBe('QC_PASSED');
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
  const { store } = await setup(); const report = await runQc(store.root, { probe, probeMedia: async () => media, analyzeAudio });
  expect(report.status).toBe('QC_PASSED'); expect(report.errors).toEqual([]);
  expect(report.inputHashes['output/final.mp4']).toMatch(/^[a-f0-9]{64}$/);
});

it.each([59, 121])('rejects an actual final duration of %s seconds independently of voice agreement', async duration => {
  const f = await setup();
  const report = await runQc(f.store.root, { probe: { probe: async () => ({ ...(await probe.probe('')), durationMs: duration * 1000 }) }, probeMedia: async () => ({ ...media, format: { duration } }) });
  expect(report.errors.some(e => e.check === 'duration' && /60.*120/.test(e.message))).toBe(true);
});
it.each([
  ['clipping', { integratedLufs: -18, truePeakDbtp: 0, silenceSegments: [] }],
  ['silence', { integratedLufs: -18, truePeakDbtp: -3, silenceSegments: [{ startMs: 4000, endMs: 7500 }] }],
  ['unmeasured', { integratedLufs: null, truePeakDbtp: null, silenceSegments: [] }],
] as const)('fails audio QC on %s rather than counting an absent check as a pass', async (_label, metrics) => {
  const f = await setup();
  const report = await runQc(f.store.root, { probe, probeMedia: async () => media, analyzeAudio: async () => ({ ...metrics, silenceSegments: [...metrics.silenceSegments] }) });
  expect(report.status).toBe('FAILED_QC');
  expect(report.errors.some(e => e.check.startsWith('audio'))).toBe(true);
});
it('fails music whose measured effective level is less than 16 dB below narration', async () => {
  const f = await selectedProduction(); roots.push(f.parent); await mkdir(join(f.store.root, 'output')); await writeFile(join(f.store.root, 'output/final.mp4'), 'offline video');
  const report = await runQc(f.store.root, { probe, probeMedia: async () => media, analyzeAudio: async path => ({ integratedLufs: path.endsWith('music.wav') ? -22 : -20, truePeakDbtp: -3, silenceSegments: [] }) });
  expect(report.errors.some(e => e.check === 'audio-music-relative')).toBe(true);
});
it('preserves the final-media path boundary before new audio measurement', async () => {
  const f = await setup(); const outside = join(f.parent, 'outside'); await mkdir(outside); await writeFile(join(outside, 'final.mp4'), 'outside project');
  await rename(join(f.store.root, 'output'), join(f.store.root, 'original-output')); await symlink(outside, join(f.store.root, 'output'), 'junction');
  const report = await runQc(f.store.root, { probe, probeMedia: async () => media, analyzeAudio });
  expect(report.errors.some(e => e.check === 'audio-finalMix' && /outside|within|symlink/i.test(e.message))).toBe(true);
  expect(report.audioMeasurements.finalMix).toBeUndefined();
});
