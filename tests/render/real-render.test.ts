import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { ProjectStore } from '../../src/store/project-store';
import { BudgetGuard } from '../../src/config';
import { ProviderRegistry } from '../../src/providers/registry';
import { OpenAiTtsAdapter } from '../../src/providers/tts/openai';
import { projectManifestSchema } from '../../src/domain/schemas';
import { hashScript, hashCanonicalJson } from '../../src/script/hash-script';
import { scriptNarrationText } from '../../src/script/narration';
import { writeEditPlan } from '../../src/edit/build-edit-plan';
import { fixture } from '../edit/fixtures';
import { persistDurableApproval } from '../voice/fixtures';
import {
  resolveManagedMediaTools,
  executeMediaTool,
  probeMedia,
  assertRenderedMedia,
} from '../../src/render/media-tools';
import { renderVideo } from '../../src/render/render-video';
import { generateManagedVoice } from '../../src/voice/generate-managed-voice';

it('renders a real offline six-second 1080x1920 H264/AAC MP4 through official voice readers', async () => {
  const cache = resolve('projects/render-smoke');
  await mkdir(cache, { recursive: true });
  const parent = await mkdtemp(join(cache, 'run-'));
  const store = await ProjectStore.create(parent, 'topic-001');
  const tools = await resolveManagedMediaTools();
  // Renderer smoke uses a synthetic sine tone, NOT speech or production narration acceptance.
  const raw = Buffer.alloc(24000 * 6 * 2);
  for (let i = 0; i < 24000 * 6; i++)
    raw.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 1800),
      i * 2,
    );
  const rawPath = join(parent, 'tone.pcm');
  await writeFile(rawPath, raw);
  const input = join(parent, 'tone-24k.wav');
  await executeMediaTool(tools.ffmpeg, [
    '-y',
    '-f',
    's16le',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-i',
    rawPath,
    '-c:a',
    'pcm_s16le',
    input,
  ]);
  const converted = join(parent, 'tone-48k.wav');
  await tools.converter.convertToWav48k(input, converted);
  expect(await tools.probe.probe(converted)).toMatchObject({
    durationMs: 6000,
    sampleRateHz: 48000,
    channels: 1,
    codecName: 'pcm_s16le',
  });
  const f = fixture();
  f.approvedScript.script.sentences[3].sourceIds = ['comment-1'];
  f.approvedScript.scriptHash = hashScript(f.approvedScript.script);
  await persistDurableApproval(store, f.approvedScript);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  manifest.sources.push({
    ...manifest.sources[0],
    id: 'comment-1',
    sourceType: 'comment-sample',
    evidenceWeight: 'low',
  });
  await store.writeJson('project.json', projectManifestSchema, manifest);
  const commitPath = join(store.root, 'script-approval.commit.json');
  const commit = JSON.parse(await readFile(commitPath, 'utf8'));
  await writeFile(
    commitPath,
    JSON.stringify({
      ...commit,
      projectSnapshot: manifest,
      projectHash: hashCanonicalJson(manifest),
    }),
  );
  let requestedText = '';
  const adapter = new OpenAiTtsAdapter({
    apiKey: 'offline-fixture-only',
    costCnyPerThousandCharacters: 0,
    fetch: async (_url, init) => {
      requestedText = JSON.parse(init!.body as string).input;
      return new Response(new Uint8Array(await readFile(input)), {
        status: 200,
      });
    },
  });
  await generateManagedVoice({
    store,
    attemptId: randomUUID(),
    requestedScriptHash: f.approvedScript.scriptHash,
    budgetGuard: new BudgetGuard({ limitCny: 0, spentCny: 0, dryRun: false }),
    registry: ProviderRegistry.fromTtsAdapters([adapter]),
  });
  expect(requestedText).toBe(scriptNarrationText(f.approvedScript.script));
  await mkdir(join(store.root, 'assets'));
  await mkdir(join(store.root, 'licenses'));
  await mkdir(join(store.root, 'generation'));
  await writeFile(join(store.root, 'assets', 'abstract.png'), proceduralPng());
  await executeMediaTool(tools.ffmpeg, [
    '-y',
    '-loop',
    '1',
    '-i',
    join(store.root, 'assets', 'abstract.png'),
    '-t',
    '2',
    '-r',
    '30',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    join(store.root, 'assets', 'clip.mp4'),
  ]);
  await writeFile(
    join(store.root, 'assets', 'music.wav'),
    await readFile(converted),
  );
  for (const id of ['clip', 'abstract', 'music'])
    await writeFile(
      join(store.root, 'licenses', `${id}.txt`),
      'Original procedural test fixture. Permission granted for offline renderer tests; not third-party media.',
    );
  await writeFile(
    join(store.root, 'generation', 'abstract.json'),
    JSON.stringify({
      provider: 'offline-procedural-test',
      description:
        'Procedural image stand-in for AI-abstract path; no AI/network invoked.',
    }),
  );
  const assets = {
    ...f.assets,
    assets: [
      {
        schemaVersion: 1 as const,
        id: 'clip',
        kind: 'clip' as const,
        path: 'assets/clip.mp4',
        sentenceIds: ['sentence-mechanism'],
        permission: 'permitted' as const,
        permissionRecord: {
          schemaVersion: 1 as const,
          assetId: 'clip',
          reference: 'licenses/clip.txt',
        },
      },
      {
        schemaVersion: 1 as const,
        id: 'abstract',
        kind: 'generated-abstract' as const,
        path: 'assets/abstract.png',
        sentenceIds: ['sentence-judgment'],
        permission: 'permitted' as const,
        permissionRecord: {
          schemaVersion: 1 as const,
          assetId: 'abstract',
          reference: 'licenses/abstract.txt',
        },
        generationRecord: {
          schemaVersion: 1 as const,
          assetId: 'abstract',
          provider: 'offline-procedural-test',
          reference: 'generation/abstract.json',
        },
      },
      {
        schemaVersion: 1 as const,
        id: 'music',
        kind: 'music' as const,
        path: 'assets/music.wav',
        sentenceIds: [],
        permission: 'permitted' as const,
        permissionRecord: {
          schemaVersion: 1 as const,
          assetId: 'music',
          reference: 'licenses/music.txt',
        },
      },
    ],
  };
  const plan = await writeEditPlan(store, tools.probe, assets, {
    tone: 'neutral',
    informationDensity: 'normal',
  });
  expect(plan.scenes[3]).toMatchObject({
    publicQuestionLabel: '公众疑问（非事实证据）',
    visual: { kind: 'authorized-clip' },
  });
  expect(plan.scenes[5].visual.kind).toBe('ai-abstract');
  expect(plan.music.mode).toBe('ambient');
  const result = await renderVideo(store.root);
  expect(result.durationMs).toBe(6000);
  expect(result.outputPath).toBe(join(store.root, 'output', 'final.mp4'));
  assertRenderedMedia(await probeMedia(result.outputPath), 6000);
  await expect(
    access(join(store.root, 'output', 'final.partial.mp4')),
  ).rejects.toThrow();
  await executeMediaTool(tools.ffmpeg, [
    '-y',
    '-ss',
    '1.7',
    '-i',
    result.outputPath,
    '-frames:v',
    '1',
    join(store.root, 'output', 'representative.png'),
  ]);
  await executeMediaTool(tools.ffmpeg, [
    '-y',
    '-ss',
    '3.0',
    '-i',
    result.outputPath,
    '-frames:v',
    '1',
    join(store.root, 'output', 'clip-label.png'),
  ]);
  console.log(
    'REAL_RENDER_ARTIFACT',
    result.outputPath,
    'voice=tone, not speech',
  );
  // Stale locked narration must fail before any output replacement.
  const previous = await readFile(result.outputPath);
  await writeFile(
    join(store.root, 'edit-plan.json'),
    JSON.stringify({ ...plan, voiceReportHash: 'f'.repeat(64) }),
  );
  await expect(renderVideo(store.root)).rejects.toThrow(/hash/);
  expect(await readFile(result.outputPath)).toEqual(previous);
  const unsupported = structuredClone(plan);
  if (unsupported.scenes[5].visual.kind !== 'ai-abstract')
    throw new Error('fixture missing abstract');
  unsupported.scenes[5].visual.asset.path = 'assets/clip.mp4';
  await writeFile(
    join(store.root, 'edit-plan.json'),
    JSON.stringify(unsupported),
  );
  await expect(renderVideo(store.root)).rejects.toThrow(
    /unsupported AI abstract/,
  );
  await writeFile(join(store.root, 'edit-plan.json'), JSON.stringify(plan));
  const license = join(store.root, 'licenses', 'clip.txt');
  const permissionText = await readFile(license);
  const { unlink } = await import('node:fs/promises');
  await unlink(license);
  await expect(renderVideo(store.root)).rejects.toThrow();
  await writeFile(license, permissionText);
  expect(await readFile(result.outputPath)).toEqual(previous);
}, 180000);

function proceduralPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64, 0);
  header.writeUInt32BE(64, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(64 * (64 * 3 + 1));
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) {
      const i = y * 193 + 1 + x * 3;
      pixels[i] = 30 + x * 3;
      pixels[i + 1] = 160;
      pixels[i + 2] = 100;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
