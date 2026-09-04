/** Explicit offline integration fixture builder. Never executes during ordinary unit tests. */
import { access, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { prepared } from '../workflow/fixtures';
import { resolveManagedMediaTools, executeMediaTool } from '../../src/render/media-tools';
import { ProviderRegistry } from '../../src/providers/registry';
import { runNextStage, readWorkflowStatus } from '../../src/workflow/run-stage';

const root = resolve('tests/fixtures/complete-project');
try { await access(root); throw new Error('complete-project already exists; preserve it rather than overwrite'); }
catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
const f = await prepared(resolve('tests/fixtures'), 'complete-project');
const tools = await resolveManagedMediaTools();
const rawPath = join(root, 'fixture-tone.pcm');
const source = join(root, 'fixture-tone.wav');
const raw = Buffer.alloc(48000 * 60 * 2);
for (let i = 0; i < 48000 * 60; i++) raw.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 48000) * 1000), i * 2);
await writeFile(rawPath, raw);
await executeMediaTool(tools.ffmpeg, ['-y', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', rawPath, '-c:a', 'pcm_s16le', source]);
const registry = ProviderRegistry.fromTtsAdapters([{ id: 'offline-technical-fixture', mode: 'direct', supports: () => true, available: async () => true,
  estimate: async () => ({ providerId: 'offline-technical-fixture', currency: 'CNY', amount: 0, basis: 'local procedural test tone; no speech synthesis or external call' }),
  synthesize: async request => { await writeFile(request.outputPath, await readFile(source)); return { ...request, audioPath: request.outputPath, durationMs: 60000, providerId: 'offline-technical-fixture', model: 'tone-not-speech', cost: { providerId: 'offline-technical-fixture', currency: 'CNY', amount: 0, basis: 'local procedural test tone; no speech synthesis or external call' } }; },
}]);
for (const expected of ['VOICE_READY', 'EDIT_PLAN_READY', 'RENDERED', 'QC_PASSED', 'COMPLETE']) {
  const state = await runNextStage(f.store.root, { registry, probe: tools.probe, converter: tools.converter, limitCny: 0, consent: { actor: 'fixture-builder', reference: 'offline-technical-fixture-only' }, print: console.log });
  console.log(state); if (state !== expected) throw new Error(`expected ${expected}, got ${state}`);
}
console.log(JSON.stringify(await readWorkflowStatus(root), null, 2));
