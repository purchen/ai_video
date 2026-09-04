import { mkdir, realpath, rename, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectManifestSchema } from '../domain/schemas';
import { assetManifestSchema, editPlanSchema, type EditPlan, type AssetManifest } from '../edit/build-edit-plan';
import { readApprovedScript, readApprovedTopic } from '../review/approve';
import { boundedLocalFile } from '../render/render-video';
import { assertRenderedMedia, probeMedia, resolveManagedMediaTools, type MediaMetadata } from '../render/media-tools';
import { validateRenderInputs } from '../render/validate-inputs';
import { ProjectStore } from '../store/project-store';
import { readCommittedVoice } from '../voice/generate-voice';
import type { AudioProbe } from '../voice/probe-audio';
import { withProjectLock } from '../workflow/project-lock';
import { sha256Bytes } from '../voice/artifacts';
import { hashCanonicalJson } from '../script/hash-script';
import { audioMeasurementsSchema, createFfmpegAudioAnalyzer, type AudioAnalyzer, type AudioMeasurements } from '../voice/analyze-audio';

export const qcReportSchema = z.object({ schemaVersion: z.literal(1), checkedAt: z.string().datetime(), status: z.enum(['QC_PASSED', 'FAILED_QC']), errors: z.array(z.object({ check: z.string(), message: z.string() })), artifacts: z.array(z.string()), inputHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  audioMeasurements: z.object({ narration: audioMeasurementsSchema.optional(), finalMix: audioMeasurementsSchema.optional(), music: audioMeasurementsSchema.optional(), musicRelativeDb: z.number().finite().optional() }),
  manualChecks: z.array(z.object({ check: z.literal('intelligibility'), status: z.literal('REQUIRED'), message: z.string() })).min(1),
});
export type QcReport = z.infer<typeof qcReportSchema>;
export interface QcDependencies { probe?: AudioProbe; probeMedia?: (path: string) => Promise<MediaMetadata>; analyzeAudio?: AudioAnalyzer }

/** Only final selected resources are authoritative; unused unknown candidates are safely ignored. */
export function selectedResourcePaths(plan: EditPlan): string[] {
  const selected = plan.scenes.flatMap(s => 'asset' in s.visual ? [s.visual.asset] : []);
  if (plan.music.mode === 'ambient') selected.push(plan.music.asset);
  return [...new Set(selected.flatMap(a => [a.path, a.permissionRecord.reference, ...(a.generationRecord ? [a.generationRecord.reference] : [])]))].sort();
}
export async function validateSelectedResources(root: string, plan: EditPlan, assets: AssetManifest): Promise<void> {
  if (assets.projectId !== plan.projectId) throw new Error('selected asset project mismatch');
  const selected = plan.scenes.flatMap(s => 'asset' in s.visual ? [s.visual.asset] : []);
  if (plan.music.mode === 'ambient') selected.push(plan.music.asset);
  for (const a of selected) {
    const source = assets.assets.find(v => v.id === a.assetId);
    if (!source || source.permission !== 'permitted' || source.path !== a.path
      || hashCanonicalJson(source.permissionRecord ?? null) !== hashCanonicalJson(a.permissionRecord)
      || hashCanonicalJson(source.generationRecord ?? null) !== hashCanonicalJson(a.generationRecord ?? null)) throw new Error(`selected asset ${a.assetId} lacks matching permission/generation provenance`);
  }
  for (const path of selectedResourcePaths(plan)) await boundedLocalFile(root, path);
}

/** Read-only aggregate inspection; the public writer and workflow own the process lock. */
export async function inspectQc(root: string, dependencies: QcDependencies = {}): Promise<QcReport> {
  const store = await ProjectStore.create(dirname(root), basename(root));
  const errors: QcReport['errors'] = [];
  const check = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => { try { return await run(); } catch (e) { errors.push({ check: name, message: e instanceof Error ? e.message : String(e) }); return undefined; } };
  const manifest = await check('manifest', () => store.readJson('project.json', projectManifestSchema));
  await check('topic-approval', () => readApprovedTopic(store));
  const approved = await check('script-approval', () => readApprovedScript(store));
  const voice = await check('voice', async () => readCommittedVoice(store, dependencies.probe ?? (await resolveManagedMediaTools()).probe));
  const assets = await check('assets', async () => {
    const value = await store.readJson('asset-manifest.json', assetManifestSchema);
    if (manifest && value.projectId !== manifest.id) throw new Error('asset project mismatch');
    return value;
  });
  const plan = await check('edit-plan', async () => {
    const plan = await store.readJson('edit-plan.json', editPlanSchema);
    if (!manifest || !approved || !voice || !assets) throw new Error('validate manifest, approvals, voice and assets before edit plan');
    validateRenderInputs(plan, { approvedScript: approved, voiceReport: voice.report, timings: voice.timings, sources: manifest.sources });
    await validateSelectedResources(root, plan, assets);
    return plan;
  });
  const media = await check('media', async () => {
    const path = await boundedLocalFile(root, 'output/final.mp4');
    const info = await (dependencies.probeMedia ?? probeMedia)(path);
    // Even when another artifact is invalid, inspect stream/geometry independently.
    assertRenderedMedia(info, voice?.report.durationMs ?? info.format.duration * 1000);
    return info;
  });
  if (media) await check('duration', async () => {
    if (media.format.duration < 60 || media.format.duration > 120) throw new Error('production final video must be between 60 and 120 seconds');
  });
  const audioMeasurements: QcReport['audioMeasurements'] = {};
  const analyze: AudioAnalyzer = dependencies.analyzeAudio ?? (async (path, options) => createFfmpegAudioAnalyzer((await resolveManagedMediaTools()).ffmpeg)(path, options));
  const measure = async (name: 'narration' | 'finalMix', path: string) => {
    await check(`audio-${name}`, async () => {
      const safePath = name === 'finalMix' ? await boundedLocalFile(root, 'output/final.mp4') : path;
      const measurement = audioMeasurementsSchema.parse(await analyze(safePath)); audioMeasurements[name] = measurement;
      assertAudibleUnclipped(measurement);
    });
  };
  if (voice) await measure('narration', voice.masterPath);
  await measure('finalMix', join(root, 'output/final.mp4'));
  if (plan?.music.mode === 'ambient') await check('audio-music-relative', async () => {
    const music = plan.music;
    if (music.mode !== 'ambient') return;
    const levels = audioMeasurementsSchema.parse(await analyze(await boundedLocalFile(root, music.asset.path), { gainDb: music.relativeGainDb, durationMs: plan.voice.durationMs, loop: true }));
    audioMeasurements.music = levels;
    const narration = audioMeasurements.narration?.integratedLufs;
    if (narration == null || levels.integratedLufs === null) throw new Error('music/narration relative loudness is unmeasured; supply measurable audio or omit music');
    const relative = levels.integratedLufs - narration;
    audioMeasurements.musicRelativeDb = relative;
    if (relative > -16) throw new Error(`effective music is ${relative.toFixed(2)} dB relative to narration; reduce music gain to reach at most -16 dB or omit music`);
  });
  const artifacts = ['topic-card.json', 'topic-approval.commit.json', 'approved-script.json', 'script-approval.commit.json', 'asset-manifest.json', 'edit-plan.json', 'voice/current.json', 'output/final.mp4', ...(plan ? selectedResourcePaths(plan) : [])];
  const inputHashes: Record<string, string> = {};
  for (const path of artifacts) await check(`hash:${path}`, async () => { inputHashes[path] = sha256Bytes(await readFile(await boundedLocalFile(root, path))); });
  return qcReportSchema.parse({ schemaVersion: 1, checkedAt: new Date().toISOString(), status: errors.length ? 'FAILED_QC' : 'QC_PASSED', errors, artifacts: ['project.json', ...artifacts, ...(voice ? [voice.masterPath] : [])], inputHashes, audioMeasurements,
    manualChecks: [{ check: 'intelligibility', status: 'REQUIRED', message: 'Human listening review of narration intelligibility, exact words and caption timing is required before publication; no ASR or listening pass is claimed.' }],
  });
}
function assertAudibleUnclipped(levels: AudioMeasurements): void {
  if (levels.integratedLufs === null || levels.truePeakDbtp === null) throw new Error('required audio loudness/peak is unmeasured or audio is silent');
  if (levels.truePeakDbtp >= -0.1) throw new Error(`possible clipping: true peak ${levels.truePeakDbtp} dBTP; reduce gain/re-export`);
  if (levels.integratedLufs < -45) throw new Error(`narration/mix is too quiet (${levels.integratedLufs} LUFS); review gain`);
  if (levels.silenceSegments.some(s => s.endMs - s.startMs >= 2000)) throw new Error('audio contains a silence segment of at least 2 seconds below -50 dB; review recording/edit');
}
export async function persistQc(root: string, report: QcReport): Promise<void> {
  const directory = join(root, 'reports'); await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('reports must not be a symlink');
  const temporary = join(directory, `.qc-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(qcReportSchema.parse(report), null, 2) + '\n');
  await rename(temporary, join(directory, 'qc.json'));
}
export async function runQc(root: string, dependencies: QcDependencies = {}): Promise<QcReport> {
  root = await realpath(root);
  return withProjectLock(root, async () => { const report = await inspectQc(root, dependencies); await persistQc(root, report); return report; });
}
