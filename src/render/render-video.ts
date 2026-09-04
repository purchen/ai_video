import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import {
  ensureBrowser,
  renderMedia,
  selectComposition,
} from '@remotion/renderer';
import { projectManifestSchema } from '../domain/schemas';
import {
  editPlanSchema,
  projectRelativePathSchema,
} from '../edit/build-edit-plan';
import { readApprovedScript } from '../review/approve';
import { ProjectStore } from '../store/project-store';
import { readCommittedVoice } from '../voice/generate-voice';
import { compositionMetadata } from '../../remotion/metadata';
import { validateRenderInputs } from './validate-inputs';
import { assertStaticImage } from './static-image';
import {
  assertRenderedMedia,
  assertClipCoverage,
  probeMedia,
  resolveManagedMediaTools,
} from './media-tools';

export async function boundedLocalFile(
  root: string,
  path: string,
): Promise<string> {
  projectRelativePathSchema.parse(path);
  const base = await realpath(root);
  const target = await realpath(join(base, path));
  const rel = relative(base, target);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    resolve(base, rel) !== target ||
    !(await stat(target)).isFile()
  )
    throw new Error('asset must be a regular local file within the project');
  return target;
}

/** A failed attempt never promotes a partial file or destroys a previous successful render. */
export async function publishRenderedFile(
  partial: string,
  final: string,
  durationMs: number,
): Promise<void> {
  assertRenderedMedia(await probeMedia(partial), durationMs);
  await rename(partial, final);
}

export async function renderVideo(
  projectRoot: string,
): Promise<{ outputPath: string; durationMs: number }> {
  const root = await realpath(projectRoot);
  const store = await ProjectStore.create(dirname(root), basename(root));
  const tools = await resolveManagedMediaTools();
  const approvedScript = await readApprovedScript(store);
  const voice = await readCommittedVoice(store, tools.probe);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  const plan = validateRenderInputs(
    await store.readJson('edit-plan.json', editPlanSchema),
    {
      approvedScript,
      voiceReport: voice.report,
      timings: voice.timings,
      sources: manifest.sources,
    },
  );
  const paths = new Map<string, string>();
  paths.set(
    plan.voice.masterPath,
    await boundedLocalFile(root, plan.voice.masterPath),
  );
  for (const scene of plan.scenes) {
    const v = scene.visual;
    if (v.kind === 'kinetic-text') {
      if ([...v.text].length > 90)
        throw new Error(
          'unsupported long kinetic text; requires reviewed layout',
        );
      continue;
    }
    if (v.kind === 'source-card') {
      if (
        v.sources.length > 2 ||
        v.sources.some(
          (s) => [...s.title].length > 70 || [...s.publisher].length > 40,
        )
      )
        throw new Error(
          'unsupported source card density; requires reviewed layout',
        );
      continue;
    }
    await boundedLocalFile(root, v.asset.permissionRecord.reference);
    if (v.asset.generationRecord)
      await boundedLocalFile(root, v.asset.generationRecord.reference);
    const file = await boundedLocalFile(root, v.asset.path);
    const extension = extname(file).toLowerCase();
    if (
      v.kind === 'ai-abstract' &&
      !['.png', '.jpg', '.jpeg', '.webp'].includes(extension)
    )
      throw new Error('unsupported AI abstract: local raster image required');
    if (v.kind === 'ai-abstract')
      assertStaticImage(await readFile(file), extension);
    if (v.kind === 'authorized-clip') {
      if (!['.mp4', '.webm', '.mov'].includes(extension))
        throw new Error('unsupported authorized clip format');
      const info = await probeMedia(file);
      assertClipCoverage(info, scene.endMs - scene.startMs);
    }
    paths.set(v.asset.path, file);
  }
  if (plan.music.mode === 'ambient') {
    await boundedLocalFile(root, plan.music.asset.permissionRecord.reference);
    if (plan.music.asset.generationRecord)
      await boundedLocalFile(root, plan.music.asset.generationRecord.reference);
    const file = await boundedLocalFile(root, plan.music.asset.path);
    if (!['.wav', '.mp3', '.m4a'].includes(extname(file).toLowerCase()))
      throw new Error('unsupported ambient music format');
    await tools.probe.probe(file);
    paths.set(plan.music.asset.path, file);
  }
  // Rendering never provisions or downloads. Run the explicit provisioning command first.
  const browser = await ensureBrowser({
    logLevel: 'error',
    onBrowserDownload: () => {
      throw new Error(
        'local browser missing: run npm run render:provision with download approval',
      );
    },
  });
  if (!('path' in browser))
    throw new Error('local managed browser unavailable');
  const output = join(root, 'output');
  await mkdir(output, { recursive: true });
  if ((await realpath(output)) !== output)
    throw new Error('output directory must not be a symlink');
  const working = await mkdtemp(join(output, '.render-'));
  const partial = join(output, 'final.partial.mp4');
  const final = join(output, 'final.mp4');
  try {
    const publicDir = join(working, 'public');
    await mkdir(publicDir);
    const media: Record<string, string> = {};
    for (const [path, file] of paths) {
      const name = `asset-${Object.keys(media).length}${extname(file).toLowerCase()}`;
      await copyFile(file, join(publicDir, name));
      media[path] = name;
    }
    const serveUrl = await bundle({
      entryPoint: fileURLToPath(
        new URL('../../remotion/Root.tsx', import.meta.url),
      ),
      publicDir,
      outDir: join(working, 'bundle'),
    });
    const inputProps = { plan, media };
    const composition = await selectComposition({
      serveUrl,
      id: 'OpinionVideo',
      inputProps,
      browserExecutable: browser.path,
      logLevel: 'error',
    });
    const expected = compositionMetadata(voice.report);
    if (
      composition.width !== expected.width ||
      composition.height !== expected.height ||
      composition.fps !== expected.fps ||
      composition.durationInFrames !== expected.durationInFrames
    )
      throw new Error('composition metadata mismatch');
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      browserExecutable: browser.path,
      outputLocation: partial,
      codec: 'h264',
      audioCodec: 'aac',
      pixelFormat: 'yuv420p',
      crf: 20,
      concurrency: 2,
      logLevel: 'error',
    });
    await publishRenderedFile(partial, final, voice.report.durationMs);
    return { outputPath: final, durationMs: voice.report.durationMs };
  } finally {
    await rm(partial, { force: true });
    await rm(working, { recursive: true, force: true });
  }
}
