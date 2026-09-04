import { readFile, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ProjectStore } from '../../src/store/project-store';
import { runNextStage, runStage, readWorkflowStatus, withProjectLock } from '../../src/workflow/run-stage';
import { prepared, production, probe, media } from './fixtures';
import { projectManifestSchema } from '../../src/domain/schemas';
import { ProviderRegistry } from '../../src/providers/registry';
import { BudgetGuard } from '../../src/config';
import { generateVoice } from '../../src/voice/generate-voice';
import { readApprovedScript } from '../../src/review/approve';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function setup() { const f = await prepared(); roots.push(f.parent); return f; }
it('refuses DRAFT_SCRIPT without the exact durable approval state', async () => {
  const { store } = await setup(); await expect(runStage(store.root, 'draft-script', {})).rejects.toThrow('TOPIC_APPROVED is required before DRAFT_SCRIPT');
});
it('resumes provider preflight failure at voice without repeating research/script and retains valid approvals', async () => {
  const { store } = await setup(); const scriptBefore = await readFile(join(store.root, 'approved-script.json'), 'utf8');
  let available = false;
  const registry = ProviderRegistry.fromTtsAdapters([{ id: 'fake', mode: 'direct', supports: () => true, available: async () => available, estimate: async () => ({ providerId: 'fake', currency: 'CNY', amount: 1, basis: 'offline' }), synthesize: async req => { await writeFile(req.outputPath, 'audio'); return { ...req, audioPath: req.outputPath, providerId: 'fake', model: 'fake', durationMs: 60000, cost: { providerId: 'fake', currency: 'CNY', amount: 1, basis: 'offline' } }; } }]);
  const deps = { registry, probe, limitCny: 5, consent: { actor: 'editor', reference: 'test-consent' } };
  expect(await runNextStage(store.root, deps)).toBe('BLOCKED_PROVIDER');
  expect((await readWorkflowStatus(store.root)).state).toBe('BLOCKED_PROVIDER');
  await expect(readApprovedScript(store)).resolves.toBeDefined();
  const first = JSON.parse(await readFile(join(store.root, 'workflow-journal.json'), 'utf8'));
  available = true;
  expect(await runNextStage(store.root, deps)).toBe('VOICE_READY');
  expect(await readFile(join(store.root, 'approved-script.json'), 'utf8')).toBe(scriptBefore);
  const next = JSON.parse(await readFile(join(store.root, 'workflow-journal.json'), 'utf8'));
  expect(next.attemptId).toBe(first.attemptId);
});
it('never retries an ambiguous paid call or synthesizes in dry-run', async () => {
  const { store } = await setup(); let calls = 0;
  const registry = ProviderRegistry.fromTtsAdapters([{ id: 'fake', mode: 'direct', supports: () => true, available: async () => true, estimate: async () => ({ providerId: 'fake', currency: 'CNY', amount: 1, basis: 'offline' }), synthesize: async () => { calls++; throw new Error('connection lost after request'); } }]);
  const deps = { registry, probe, limitCny: 5, consent: { actor: 'editor', reference: 'test-consent' } };
  await runNextStage(store.root, { ...deps, dryRun: true }); expect(calls).toBe(0);
  await runNextStage(store.root, deps); await runNextStage(store.root, deps); expect(calls).toBe(1);
  expect((await readWorkflowStatus(store.root)).state).toBe('BLOCKED_PROVIDER');
});
it('blocks recovery when journal or manifest bindings are changed', async () => {
  const { store } = await setup(); await runNextStage(store.root, { probe });
  const path = join(store.root, 'workflow-journal.json'); const journal = JSON.parse(await readFile(path, 'utf8')); journal.manifestHash = '0'.repeat(64); await writeFile(path, JSON.stringify(journal));
  await expect(runNextStage(store.root, { probe })).rejects.toThrow(/journal/);
});
it('enforces an exclusive project lock', async () => {
  const { store } = await setup(); await withProjectLock(store.root, async () => { await expect(withProjectLock(store.root, async () => undefined)).rejects.toThrow(/lock/); });
  await expect(withProjectLock(store.root, async () => 'released')).resolves.toBe('released');
});
it('reuses edit outputs only for the same inputs, rejecting new assets instead of claiming cached success', async () => {
  const f = await production(); roots.push(f.parent);
  const manifest = await f.store.readJson('project.json', projectManifestSchema);
  await f.store.writeJson('project.json', projectManifestSchema, { ...manifest, workflowState: 'VOICE_READY' });
  expect(await runNextStage(f.store.root, { probe })).toBe('EDIT_PLAN_READY');
  const previous = await readFile(join(f.store.root, 'edit-plan.json'), 'utf8');
  expect(await runStage(f.store.root, 'edit-plan', { probe })).toBe('EDIT_PLAN_READY');
  expect(await readFile(join(f.store.root, 'edit-plan.json'), 'utf8')).toBe(previous);
  expect(await runStage(f.store.root, 'edit-plan', { probe, assets: { schemaVersion: 1, projectId: 'topic-001', assets: [{ schemaVersion: 1, id: 'new', kind: 'clip', path: 'clip.mp4', sentenceIds: [], permission: 'unknown' }] } })).toBe('BLOCKED_PERMISSION');
});
it('does not treat the durable prepared attempt as a successfully cached voice output', async () => {
  const { store } = await setup();
  // Simulate interruption after the prepared event, before any provider call.
  const registry = ProviderRegistry.fromTtsAdapters([]);
  await runNextStage(store.root, { registry, probe });
  const eventsPath = join(store.root, 'workflow-events.jsonl');
  const firstLine = (await readFile(eventsPath, 'utf8')).trim().split('\n')[0];
  const first = JSON.parse(firstLine);
  await writeFile(eventsPath, firstLine + '\n'); await writeFile(join(store.root, 'workflow-journal.json'), JSON.stringify(first.journal));
  expect(await runNextStage(store.root, { registry, probe })).toBe('BLOCKED_PROVIDER');
});
it('runs aggregate QC even when the rendered stream is invalid', async () => {
  const f = await production(); roots.push(f.parent);
  const manifest = await f.store.readJson('project.json', projectManifestSchema);
  await f.store.writeJson('project.json', projectManifestSchema, { ...manifest, workflowState: 'RENDERED' });
  expect(await runStage(f.store.root, 'qc', { probe, probeMedia: async () => ({ ...media, streams: [] }) })).toBe('FAILED_QC');
  expect(JSON.parse(await readFile(join(f.store.root, 'reports/qc.json'), 'utf8')).errors.some((e: { check: string }) => e.check === 'media')).toBe(true);
});
it('blocks a project voice junction before writing any manual package outside the project', async () => {
  const f = await setup(); const outside = join(f.parent, 'outside'); await mkdir(outside);
  await symlink(outside, join(f.store.root, 'voice'), 'junction');
  await expect(runNextStage(f.store.root, { probe })).rejects.toThrow(/symlink|junction|within/);
});
it('executes a paid voice only under explicit current-call authorization without a project budget', async () => {
  const { store } = await setup(); let calls = 0;
  const registry = ProviderRegistry.fromTtsAdapters([{ id: 'fake', mode: 'direct', supports: () => true, available: async () => true, estimate: async () => ({ providerId: 'fake', currency: 'CNY', amount: 1, basis: 'offline' }), synthesize: async req => { calls++; await writeFile(req.outputPath, 'audio'); return { ...req, audioPath: req.outputPath, providerId: 'fake', model: 'fake', durationMs: 60000, cost: { providerId: 'fake', currency: 'CNY', amount: 1, basis: 'offline' } }; } }]);
  expect(await runNextStage(store.root, { registry, probe, currentCallMaxCny: 1, consent: { actor: 'editor', reference: 'one-time' } })).toBe('VOICE_READY');
  expect(calls).toBe(1);
});
it('refuses to advance a renderer that returns without valid expected media', async () => {
  const f = await production(); roots.push(f.parent); const manifest = await f.store.readJson('project.json', projectManifestSchema);
  await f.store.writeJson('project.json', projectManifestSchema, { ...manifest, workflowState: 'EDIT_PLAN_READY' });
  expect(await runNextStage(f.store.root, { probe, render: async () => ({ outputPath: 'wrong.mp4', durationMs: 60000 }), probeMedia: async () => ({ streams: [], format: { duration: 60 } }) })).toBe('FAILED_RENDER');
  expect((await f.store.readJson('project.json', projectManifestSchema)).workflowState).toBe('EDIT_PLAN_READY');
});
it('recovers the durable audit attempt when the orchestration journal never existed, without a second ambiguous paid call', async () => {
  const { store } = await setup(); const approved = await readApprovedScript(store); let calls = 0;
  const registry = ProviderRegistry.fromTtsAdapters([{ id: 'fake', mode: 'direct', supports: () => true, available: async () => true, estimate: async () => ({ providerId: 'fake', currency: 'CNY', amount: 1, basis: 'offline' }), synthesize: async () => { calls++; throw new Error('ambiguous network result'); } }]);
  const attemptId = '00000000-0000-4000-8000-000000000088';
  await expect(generateVoice({ store, attemptId, requestedScriptHash: approved.scriptHash, registry, probe, budgetGuard: new BudgetGuard({ limitCny: 5, spentCny: 0, dryRun: false }) })).rejects.toThrow();
  expect(await runNextStage(store.root, { registry, probe, limitCny: 5, consent: { actor: 'editor', reference: 'consent' } })).toBe('BLOCKED_PROVIDER');
  expect(calls).toBe(1);
  expect(JSON.parse(await readFile(join(store.root, 'workflow-journal.json'), 'utf8')).attemptId).toBe(attemptId);
});
it('keeps the prior valid manifest when approval commit promotion fails', async () => {
  const f = await setup(); const manifest = await f.store.readJson('project.json', projectManifestSchema);
  await f.store.writeJson('project.json', projectManifestSchema, { ...manifest, workflowState: 'SCRIPT_REVIEW_REQUIRED' });
  const original = ProjectStore.prototype.writeJson;
  const spy = vi.spyOn(ProjectStore.prototype, 'writeJson').mockImplementation(async function(this: ProjectStore, name, schema, value) {
    if (name === 'script-approval.commit.json') throw new Error('injected commit failure');
    return original.call(this, name, schema, value);
  });
  try { expect(await runStage(f.store.root, 'approve-script', { actor: 'editor' })).toBe('BLOCKED_EVIDENCE'); }
  finally { spy.mockRestore(); }
  expect((await f.store.readJson('project.json', projectManifestSchema)).workflowState).toBe('SCRIPT_REVIEW_REQUIRED');
});
