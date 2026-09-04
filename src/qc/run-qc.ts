import { mkdir, realpath, rename, writeFile, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectManifestSchema } from '../domain/schemas';
import { assetManifestSchema, editPlanSchema } from '../edit/build-edit-plan';
import { readApprovedScript, readApprovedTopic } from '../review/approve';
import { boundedLocalFile } from '../render/render-video';
import { assertRenderedMedia, probeMedia, resolveManagedMediaTools, type MediaMetadata } from '../render/media-tools';
import { validateRenderInputs } from '../render/validate-inputs';
import { ProjectStore } from '../store/project-store';
import { readCommittedVoice } from '../voice/generate-voice';
import type { AudioProbe } from '../voice/probe-audio';
import { withProjectLock } from '../workflow/project-lock';
import { sha256Bytes } from '../voice/artifacts';

export const qcReportSchema = z.object({ schemaVersion: z.literal(1), checkedAt: z.string().datetime(), status: z.enum(['QC_PASSED', 'FAILED_QC']), errors: z.array(z.object({ check: z.string(), message: z.string() })), artifacts: z.array(z.string()), inputHashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
export type QcReport = z.infer<typeof qcReportSchema>;
export interface QcDependencies { probe?: AudioProbe; probeMedia?: (path: string) => Promise<MediaMetadata> }

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
    const issues: string[] = [];
    for (const a of value.assets) {
      if (a.permission !== 'permitted' || !a.permissionRecord) { issues.push(`${a.id}: permission required`); continue; }
      for (const path of [a.path, a.permissionRecord.reference, ...(a.generationRecord ? [a.generationRecord.reference] : [])]) {
        try { await boundedLocalFile(root, path); } catch (e) { issues.push(`${a.id}: ${path}: ${String(e)}`); }
      }
    }
    if (issues.length) throw new Error(issues.join('; '));
    return value;
  });
  await check('edit-plan', async () => {
    const plan = await store.readJson('edit-plan.json', editPlanSchema);
    if (!manifest || !approved || !voice || !assets) throw new Error('validate manifest, approvals, voice and assets before edit plan');
    validateRenderInputs(plan, { approvedScript: approved, voiceReport: voice.report, timings: voice.timings, sources: manifest.sources });
    const selected = plan.scenes.flatMap(s => 'asset' in s.visual ? [s.visual.asset] : []);
    if (plan.music.mode === 'ambient') selected.push(plan.music.asset);
    for (const a of selected) {
      const source = assets.assets.find(v => v.id === a.assetId);
      if (!source || source.permission !== 'permitted' || source.path !== a.path || source.permissionRecord?.reference !== a.permissionRecord.reference) throw new Error(`selected asset ${a.assetId} lacks matching permission`);
    }
    return plan;
  });
  await check('media', async () => {
    const path = await boundedLocalFile(root, 'output/final.mp4');
    const info = await (dependencies.probeMedia ?? probeMedia)(path);
    // Even when another artifact is invalid, inspect stream/geometry independently.
    assertRenderedMedia(info, voice?.report.durationMs ?? info.format.duration * 1000);
  });
  const artifacts = ['topic-card.json', 'topic-approval.commit.json', 'approved-script.json', 'script-approval.commit.json', 'asset-manifest.json', 'edit-plan.json', 'voice/current.json', 'output/final.mp4'];
  const inputHashes: Record<string, string> = {};
  for (const path of artifacts) await check(`hash:${path}`, async () => { inputHashes[path] = sha256Bytes(await readFile(await boundedLocalFile(root, path))); });
  return qcReportSchema.parse({ schemaVersion: 1, checkedAt: new Date().toISOString(), status: errors.length ? 'FAILED_QC' : 'QC_PASSED', errors, artifacts: ['project.json', ...artifacts, ...(voice ? [voice.masterPath] : [])], inputHashes });
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
