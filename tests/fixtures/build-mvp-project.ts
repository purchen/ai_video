/** Real offline acceptance pipeline. The only provider boundary replays preserved, hash-bound speech. */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectManifestSchema } from '../../src/domain/schemas';
import { ProviderRegistry } from '../../src/providers/registry';
import { readApprovedScript } from '../../src/review/approve';
import { scriptNarrationText } from '../../src/script/narration';
import { sha256Bytes } from '../../src/voice/artifacts';
import { readCommittedVoice } from '../../src/voice/generate-voice';
import { ProjectStore } from '../../src/store/project-store';
import { executeMediaTool, resolveManagedMediaTools } from '../../src/render/media-tools';
import { runNextStage, runStage, type StageCommand, type StageDependencies } from '../../src/workflow/run-stage';
import { fixtureDate, fixtureScript, fixtureSource } from './mvp-input';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'mvp-project');

export async function buildMvpProject(target: string) {
  const root = resolve(target);
  try { await access(join(root, 'project.json')); throw new Error('MVP project already exists; choose a fresh target, never overwrite approval/media history'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const text = await readFile(join(fixture, 'narration.txt'), 'utf8');
  const speech = await readFile(join(fixture, 'speech.wav'));
  const provenance = JSON.parse(await readFile(join(fixture, 'speech-provenance.json'), 'utf8'));
  if (scriptNarrationText(fixtureScript) !== text || sha256Bytes(Buffer.from(text)) !== provenance.narrationSha256
    || sha256Bytes(speech) !== provenance.audioSha256 || provenance.voiceId !== 'Microsoft Huihui Desktop'
    || provenance.providerId !== 'windows-system-speech-fixture' || provenance.sourceKind !== 'windows-built-in-synthetic') throw new Error('preserved speech provenance or canonical narration does not match');
  const tools = await resolveManagedMediaTools();
  const audio = await tools.probe.probe(join(fixture, 'speech.wav'));
  if (audio.durationMs < 60000 || audio.durationMs > 120000) throw new Error('fixture speech must be 60–120 seconds without stretching or silent padding');
  const store = await ProjectStore.create(dirname(root), basename(root));
  await store.writeJson('project.json', projectManifestSchema, { schemaVersion: 1, id: 'mvp-project', topic: fixtureScript.title, workflowState: 'DISCOVERED', createdAt: fixtureDate, updatedAt: fixtureDate, sources: [] });
  await writeFile(join(root, 'narration.txt'), text);
  const cost = { providerId: 'windows-system-speech-fixture', currency: 'CNY' as const, amount: 0, basis: 'replay locally synthesized Windows Huihui fixture; no paid API or external call' };
  const registry = ProviderRegistry.fromTtsAdapters([{
    id: cost.providerId, mode: 'direct', supports: request => request.voiceId === provenance.voiceId && request.voiceKind === 'synthetic', available: async () => true,
    estimate: async () => cost,
    synthesize: async request => {
      const approved = await readApprovedScript(store);
      if (request.text !== text || request.approvedScriptHash !== approved.scriptHash) throw new Error('fixture adapter refuses changed locked text or hash');
      await writeFile(request.outputPath, speech);
      return { ...request, audioPath: request.outputPath, durationMs: audio.durationMs, providerId: cost.providerId, model: provenance.model, cost };
    },
  }]);
  const deps: StageDependencies = { registry, voiceId: provenance.voiceId, probe: tools.probe, converter: tools.converter, limitCny: 0, consent: { actor: 'offline-fixture-editor', reference: 'local-synthetic-test-only-no-publish' }, print: console.log };
  const states: string[] = [];
  async function stage(command: StageCommand, expected: string, extra: StageDependencies = {}) {
    const actual = await runStage(root, command, { ...deps, ...extra }); states.push(actual);
    if (actual !== expected) throw new Error(`${command}: expected ${expected}, got ${actual}`);
  }
  async function next(expected: string) {
    const actual = await runNextStage(root, deps); states.push(actual);
    if (actual !== expected) throw new Error(`next: expected ${expected}, got ${actual}`);
  }
  await stage('discover', 'DISCOVERED', { now: new Date(fixtureDate), topicAdapters: [{ id: 'original-synthetic-topic-feed', fetch: async () => [{ title: fixtureScript.title, url: fixtureSource.url, publisher: fixtureSource.publisher, summary: fixtureSource.summary, publishedAt: fixtureDate }] }] });
  await stage('research', 'TOPIC_REVIEW_REQUIRED', { sources: [fixtureSource], candidateId: 'candidate-1' });
  await next('TOPIC_REVIEW_REQUIRED'); // Stops; never auto-approves.
  await stage('approve-topic', 'TOPIC_APPROVED', { actor: 'offline-fixture-editor', candidateId: 'candidate-1' });
  await stage('draft-script', 'SCRIPT_REVIEW_REQUIRED', { languageModel: { id: 'original-fixture-script', generate: async () => fixtureScript } });
  await next('SCRIPT_REVIEW_REQUIRED'); // Second independent human-review stop.
  await stage('approve-script', 'SCRIPT_APPROVED', { actor: 'offline-fixture-editor' });
  for (const expected of ['VOICE_READY', 'EDIT_PLAN_READY', 'RENDERED', 'QC_PASSED', 'COMPLETE']) await next(expected);
  const voice = await readCommittedVoice(store, tools.probe);
  await mkdir(join(root, 'reports'), { recursive: true });
  for (const [name, seconds] of [['beginning', 3], ['source-card', 23], ['middle', audio.durationMs / 2000], ['end', audio.durationMs / 1000 - 3]] as const) {
    await executeMediaTool(tools.ffmpeg, ['-y', '-ss', String(seconds), '-i', join(root, 'output/final.mp4'), '-frames:v', '1', join(root, 'reports', `${name}.png`)]);
  }
  console.log(JSON.stringify({ video: join(root, 'output/final.mp4'), master: voice.masterPath, narration: join(root, 'narration.txt'), durationMs: voice.report.durationMs }, null, 2));
  return { store, states };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildMvpProject(process.argv[2] ?? fixture);
}
