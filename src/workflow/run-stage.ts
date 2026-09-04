import { appendFile, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BudgetGuard } from '../config';
import { projectManifestSchema, workflowStateSchema, scriptDocumentSchema, sourceRecordSchema, type ProjectManifest } from '../domain/schemas';
import { transition, type WorkflowState } from '../domain/state-machine';
import { assetManifestSchema, editPlanSchema, writeEditPlan, type AssetManifest } from '../edit/build-edit-plan';
import type { LanguageModelAdapter, TopicSourceAdapter, TtsRequest } from '../providers/contracts';
import { ProviderRegistry } from '../providers/registry';
import { createManualVoicePackage, importManualVoice, type ManualAudioAuthorization } from '../providers/tts/manual';
import { buildResearchBrief, writeResearchArtifacts, type ResearchSource } from '../research/build-brief';
import { approveTopic, approveScript, readApprovedTopic, readApprovedScript } from '../review/approve';
import { buildScript } from '../script/build-script';
import { hashCanonicalJson } from '../script/hash-script';
import { scriptNarrationText } from '../script/narration';
import { ProjectStore } from '../store/project-store';
import { discoverTopics, topicCandidatesArtifactSchema } from '../topic/discover';
import { generateVoice, readCommittedVoice, readVoiceAttemptAudit } from '../voice/generate-voice';
import { sha256Bytes } from '../voice/artifacts';
import { sha256Schema, transactionIdSchema, costRecordSchema } from '../voice/schemas';
import type { AudioProbe, AudioConverter } from '../voice/probe-audio';
import { resolveManagedMediaTools, probeMedia, assertRenderedMedia } from '../render/media-tools';
import { renderVideo, boundedLocalFile } from '../render/render-video';
import { validateRenderInputs } from '../render/validate-inputs';
import { inspectQc, persistQc, qcReportSchema, selectedResourcePaths, validateSelectedResources, type QcDependencies } from '../qc/run-qc';
import { withProjectLock } from './project-lock';
export { withProjectLock } from './project-lock';

export const sourcesArtifactSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(sourceRecordSchema.extend({ claim: z.object({ key: z.string().min(1), value: z.enum(['affirmed', 'denied']), text: z.string().min(1) }).optional() })) });
export const commandSchema = z.enum(['discover', 'research', 'approve-topic', 'draft-script', 'approve-script', 'voice', 'import-voice', 'edit-plan', 'render', 'qc', 'finish']);
export type StageCommand = z.infer<typeof commandSchema>;
const journalBodySchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string(), sequence: z.number().int().positive(),
  manifestHash: sha256Schema, artifactHashes: z.record(z.string(), sha256Schema),
  state: workflowStateSchema, lastSuccessfulState: workflowStateSchema,
  stage: commandSchema, inputHash: sha256Schema, attemptId: transactionIdSchema.optional(),
  message: z.string(), updatedAt: z.string().datetime(),
  cache: z.record(z.string(), z.object({ inputHash: sha256Schema, state: workflowStateSchema })),
});
const journalSchema = journalBodySchema.extend({ hash: sha256Schema });
type Journal = z.infer<typeof journalSchema>;
const eventSchema = z.object({ schemaVersion: z.literal(1), sequence: z.number().int().positive(), previousHash: sha256Schema.nullable(), journal: journalSchema, hash: sha256Schema });

export interface StageDependencies extends QcDependencies {
  sources?: ResearchSource[]; topicAdapters?: TopicSourceAdapter[]; now?: Date;
  languageModel?: LanguageModelAdapter; registry?: ProviderRegistry; converter?: AudioConverter;
  assets?: AssetManifest; actor?: string; candidateId?: string; audioPath?: string;
  authorization?: ManualAudioAuthorization; limitCny?: number; currentCallMaxCny?: number; dryRun?: boolean;
  consent?: { actor: string; reference: string }; print?: (message: string) => void; render?: typeof renderVideo;
}
class Blocked extends Error { constructor(public state: WorkflowState, message: string) { super(message); } }
const failed = (state: WorkflowState) => state.startsWith('BLOCKED_') || state.startsWith('FAILED_');
const artifactNames = ['topic-candidates.json', 'sources.json', 'topic-card.json', 'topic-approval.commit.json', 'script-draft.json', 'approved-script.json', 'script-approval.commit.json', 'voice/current.json', 'voice/manual-current.json', 'asset-manifest.json', 'edit-plan.json', 'output/final.mp4'];
async function artifactHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of artifactNames) { try { result[name] = sha256Bytes(await readFile(join(root, name))); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
  // A failed QC may deliberately snapshot a malformed/missing plan. Bind its raw bytes
  // above, and bind every available selected resource whenever the plan can be parsed.
  let plan;
  try { plan = editPlanSchema.safeParse(JSON.parse(await readFile(join(root, 'edit-plan.json'), 'utf8'))); }
  catch (e) { if (!(e instanceof SyntaxError) && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (plan?.success) for (const name of selectedResourcePaths(plan.data)) {
    try { result[name] = sha256Bytes(await readFile(await boundedLocalFile(root, name))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return result;
}
async function openStore(root: string) {
  const path = await realpath(root);
  // Managed writers must never traverse user-controlled junctions, including nested transaction dirs.
  const inspect = async (name: string): Promise<void> => {
    let info; try { info = await lstat(name); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (info.isSymbolicLink()) throw new Error('managed artifacts must remain within the project without symlinks or junctions');
    if (info.isDirectory()) for (const child of await readdir(name)) await inspect(join(name, child));
  };
  for (const name of [...artifactNames, 'voice', 'reports', 'output']) await inspect(join(path, name));
  return ProjectStore.create(dirname(path), basename(path));
}
async function loadJournal(store: ProjectStore, manifest: ProjectManifest): Promise<Journal | undefined> {
  let value: Journal;
  try { value = await store.readJson('workflow-journal.json', journalSchema); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      try { await readFile(join(store.root, 'workflow-events.jsonl')); } catch (eventError) { if ((eventError as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw eventError; }
      throw new Error('workflow journal missing despite durable events; manual recovery required');
    }
    throw new Error(`invalid workflow journal: ${String(e)}`);
  }
  const { hash, ...body } = value;
  if (hashCanonicalJson(body) !== hash || value.manifestHash !== hashCanonicalJson(manifest)
    || value.projectId !== manifest.id || value.lastSuccessfulState !== manifest.workflowState
    || hashCanonicalJson(value.artifactHashes) !== hashCanonicalJson(await artifactHashes(store.root))) throw new Error('workflow journal binding mismatch; manual recovery required');
  const events = (await readFile(join(store.root, 'workflow-events.jsonl'), 'utf8')).trim().split('\n');
  let previous: string | null = null;
  for (let index = 0; index < events.length; index++) {
    const event = eventSchema.parse(JSON.parse(events[index])); const { hash: eventHash, ...eventBody } = event;
    if (event.sequence !== index + 1 || event.previousHash !== previous || hashCanonicalJson(eventBody) !== eventHash) throw new Error('workflow journal event chain mismatch');
    previous = eventHash;
    if (index === events.length - 1 && (event.journal.hash !== hash || event.sequence !== value.sequence)) throw new Error('workflow journal and latest event disagree');
  }
  return value;
}
async function saveJournal(store: ProjectStore, old: Journal | undefined, state: WorkflowState, stage: StageCommand, inputHash: string, message: string, attemptId?: string): Promise<void> {
  const manifest = await store.readJson('project.json', projectManifestSchema); const cache = { ...old?.cache };
  if (!failed(state)) cache[stage] = { inputHash, state };
  const body = journalBodySchema.parse({ schemaVersion: 1, projectId: manifest.id, sequence: (old?.sequence ?? 0) + 1, manifestHash: hashCanonicalJson(manifest), artifactHashes: await artifactHashes(store.root), state, lastSuccessfulState: manifest.workflowState, stage, inputHash, attemptId, message, updatedAt: new Date().toISOString(), cache });
  const journal = journalSchema.parse({ ...body, hash: hashCanonicalJson(body) }); let previousHash: string | null = null;
  if (old) { const lines = (await readFile(join(store.root, 'workflow-events.jsonl'), 'utf8')).trim().split('\n'); previousHash = eventSchema.parse(JSON.parse(lines.at(-1)!)).hash; }
  const eventBody = { schemaVersion: 1 as const, sequence: body.sequence, previousHash, journal };
  const event = eventSchema.parse({ ...eventBody, hash: hashCanonicalJson(eventBody) });
  // A crash between append and promotion requires manual recovery, never silent paid replay.
  await appendFile(join(store.root, 'workflow-events.jsonl'), JSON.stringify(event) + '\n');
  await store.writeJson('workflow-journal.json', journalSchema, journal);
}
async function audioProbe(deps: StageDependencies) { return deps.probe ?? (await resolveManagedMediaTools()).probe; }
async function validateSuccessArtifacts(store: ProjectStore, manifest: ProjectManifest, deps: StageDependencies): Promise<void> {
  const order: WorkflowState[] = ['DISCOVERED', 'RESEARCHED', 'TOPIC_REVIEW_REQUIRED', 'TOPIC_APPROVED', 'SCRIPT_DRAFTED', 'SCRIPT_REVIEW_REQUIRED', 'SCRIPT_APPROVED', 'VOICE_READY', 'EDIT_PLAN_READY', 'RENDERED', 'QC_PASSED', 'COMPLETE'];
  const rank = order.indexOf(manifest.workflowState);
  if (rank < 0) throw new Error('manifest contains failure state without a valid successful-state recovery snapshot');
  if (rank >= 3) await readApprovedTopic(store);
  if (rank >= 6) await readApprovedScript(store);
  if (rank >= 7) {
    const voice = await readCommittedVoice(store, await audioProbe(deps));
    if (rank >= 8) {
      const plan = validateRenderInputs(await store.readJson('edit-plan.json', editPlanSchema), { approvedScript: await readApprovedScript(store), voiceReport: voice.report, timings: voice.timings, sources: manifest.sources });
      await validateSelectedResources(store.root, plan, await store.readJson('asset-manifest.json', assetManifestSchema));
    }
    if (rank >= 9) assertRenderedMedia(await (deps.probeMedia ?? probeMedia)(join(store.root, 'output/final.mp4')), voice.report.durationMs);
  }
  if (rank >= 10) {
    const report = qcReportSchema.parse(JSON.parse(await readFile(join(store.root, 'reports/qc.json'), 'utf8')));
    if (report.status !== 'QC_PASSED' || report.errors.length) throw new Error('successful state requires passing QC report');
    const current = await inspectQc(store.root, deps);
    if (current.status !== 'QC_PASSED' || hashCanonicalJson(current.inputHashes) !== hashCanonicalJson(report.inputHashes)) throw new Error('QC report inputs are stale or no longer valid');
  }
}
export async function readWorkflowStatus(root: string, deps: StageDependencies = {}) {
  const store = await openStore(root); const manifest = await store.readJson('project.json', projectManifestSchema); const journal = await loadJournal(store, manifest);
  const diagnostics: Array<{ check: string; message: string }> = [];
  try { await validateSuccessArtifacts(store, manifest, deps); }
  catch (error) {
    if (!journal || !failed(journal.state)) throw error;
    diagnostics.push({ check: 'current-artifacts', message: error instanceof Error ? error.message : String(error) });
  }
  if (journal?.state === 'FAILED_QC') {
    try { const report = qcReportSchema.parse(JSON.parse(await readFile(join(store.root, 'reports/qc.json'), 'utf8'))); diagnostics.push(...report.errors); }
    catch (error) { diagnostics.push({ check: 'qc-report', message: error instanceof Error ? error.message : String(error) }); }
  }
  return { state: journal?.state ?? manifest.workflowState, lastSuccessfulState: manifest.workflowState, message: journal?.message ?? '', diagnostics, artifacts: Object.keys(await artifactHashes(store.root)).map(path => join(store.root, path)), projectId: manifest.id };
}
function nextCommand(state: WorkflowState): StageCommand | undefined {
  const next: Partial<Record<WorkflowState, StageCommand>> = { DISCOVERED: 'research', RESEARCHED: 'research', TOPIC_APPROVED: 'draft-script', SCRIPT_APPROVED: 'voice', VOICE_READY: 'edit-plan', EDIT_PLAN_READY: 'render', RENDERED: 'qc', QC_PASSED: 'finish' };
  return next[state];
}
export async function runNextStage(root: string, deps: StageDependencies = {}): Promise<WorkflowState> {
  return withProjectLock(root, async () => {
    const store = await openStore(root); const manifest = await store.readJson('project.json', projectManifestSchema); const journal = await loadJournal(store, manifest);
    const stage = journal && failed(journal.state) ? journal.stage : nextCommand(manifest.workflowState);
    if (!stage) { await validateSuccessArtifacts(store, manifest, deps); return journal?.state ?? manifest.workflowState; }
    return executeStage(store, stage, deps, manifest, journal);
  });
}
export async function runStage(root: string, command: StageCommand, deps: StageDependencies = {}): Promise<WorkflowState> {
  commandSchema.parse(command);
  return withProjectLock(root, async () => { const store = await openStore(root); const manifest = await store.readJson('project.json', projectManifestSchema); return executeStage(store, command, deps, manifest, await loadJournal(store, manifest)); });
}
async function hydrateBudget(store: ProjectStore, limitCny?: number, currentCallMaxCny?: number): Promise<BudgetGuard> {
  if (currentCallMaxCny !== undefined) z.number().finite().nonnegative().parse(currentCallMaxCny);
  let ids: string[];
  try { ids = await readdir(join(store.root, 'voice/audit')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') ids = []; else throw e; }
  const bundles = await Promise.all(ids.sort().map(id => readVoiceAttemptAudit(store, id)));
  const historicalExposure = bundles.reduce((total, b) => total + (b.settlement?.actual.amount ?? b.reservation?.authorizedMaxCny ?? 0), 0);
  const guard = new BudgetGuard({ spentCny: 0, limitCny: currentCallMaxCny === undefined ? limitCny : historicalExposure + currentCallMaxCny, dryRun: false });
  for (const { reservation: r, settlement } of bundles) {
    if (!r) throw new Error('voice reservation audit missing'); const id = r.attemptId;
    guard.restoreReservation({ reservationId: id, providerId: r.providerId, currency: 'CNY', maximumAmountCny: r.authorizedMaxCny, remainingAtAuthorizationCny: r.remainingAtAuthorizationCny }, r.estimate);
    if (settlement) guard.settleReservation(id, settlement.actual);
  }
  return guard;
}
async function researchContext(store: ProjectStore, preferredId?: string) {
  const candidates = (await store.readJson('topic-candidates.json', topicCandidatesArtifactSchema)).candidates.map((candidate, i) => ({ id: `candidate-${i + 1}`, candidate }));
  let selected = candidates.find(c => c.id === (preferredId ?? 'candidate-1'));
  if (!preferredId) { try { const approval = await readApprovedTopic(store); selected = candidates.find(c => c.id === approval.candidateId && hashCanonicalJson(c.candidate) === hashCanonicalJson(approval.candidate)); } catch (e) { const manifest = await store.readJson('project.json', projectManifestSchema); if (!['DISCOVERED', 'RESEARCHED', 'TOPIC_REVIEW_REQUIRED'].includes(manifest.workflowState)) throw e; } }
  if (!selected) throw new Error('selected topic candidate is missing or changed');
  const { sources } = await store.readJson('sources.json', sourcesArtifactSchema);
  return { candidates, brief: buildResearchBrief(selected.candidate, sources), sources };
}
async function stageInput(store: ProjectStore, command: StageCommand, deps: StageDependencies): Promise<string> {
  const all = await artifactHashes(store.root);
  const names: Partial<Record<StageCommand, string[]>> = { discover: [], research: ['topic-candidates.json'], 'approve-topic': ['topic-candidates.json', 'sources.json'], 'draft-script': ['topic-card.json', 'sources.json'], 'approve-script': ['script-draft.json', 'sources.json'], voice: ['approved-script.json'], 'import-voice': ['approved-script.json', 'voice/manual-current.json'], 'edit-plan': ['approved-script.json', 'voice/current.json'], render: ['edit-plan.json', 'voice/current.json', 'asset-manifest.json'], qc: artifactNames, finish: ['output/final.mp4', 'edit-plan.json'] };
  const resources = Object.fromEntries(Object.entries(all).filter(([name]) => !artifactNames.includes(name)));
  return hashCanonicalJson({ artifacts: Object.fromEntries((names[command] ?? []).map(n => [n, all[n] ?? null])), ...(Object.keys(resources).length && ['render', 'qc'].includes(command) ? { resources } : {}), sources: deps.sources ?? null, assets: deps.assets ?? null, audio: deps.audioPath ? sha256Bytes(await readFile(deps.audioPath)) : null, authorization: deps.authorization ?? null, candidate: deps.candidateId ?? null, model: deps.languageModel?.id ?? null, feeds: command === 'discover' ? deps.topicAdapters?.map(a => a.id) ?? [] : null });
}
async function persistedVoiceAttempt(store: ProjectStore): Promise<string | undefined> {
  let ids: string[];
  try { ids = await readdir(join(store.root, 'voice/audit')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  const bundles = await Promise.all(ids.map(id => readVoiceAttemptAudit(store, id)));
  const pending = bundles.filter(b => b.attempt.status !== 'COMMITTED');
  if (pending.length > 1) throw new Error('multiple pending voice attempts require manual recovery; no new paid identity may be created');
  return pending[0]?.attempt.attemptId ?? bundles.sort((a, b) => b.attempt.updatedAt.localeCompare(a.attempt.updatedAt))[0]?.attempt.attemptId;
}
async function executeStage(store: ProjectStore, command: StageCommand, deps: StageDependencies, manifest: ProjectManifest, old?: Journal): Promise<WorkflowState> {
  const previousManifest = manifest;
  const inputHash = await stageInput(store, command, deps);
  if (command === 'draft-script' && manifest.workflowState !== 'TOPIC_APPROVED') throw new Error('TOPIC_APPROVED is required before DRAFT_SCRIPT');
  if (command !== 'qc') await validateSuccessArtifacts(store, manifest, deps);
  if (old?.cache[command]?.inputHash === inputHash && !failed(old.state) && !['approve-topic', 'approve-script', 'draft-script'].includes(command)) {
    if (command === 'qc') await validateSuccessArtifacts(store, manifest, deps);
    return old.state;
  }
  let attemptId = old?.attemptId;
  if (command === 'voice' && !attemptId) attemptId = await persistedVoiceAttempt(store) ?? randomUUID();
  if (command === 'voice') { await saveJournal(store, old, 'BLOCKED_PROVIDER', command, inputHash, 'voice attempt prepared; not yet completed', attemptId); old = await loadJournal(store, manifest); }
  const update = async (state: WorkflowState) => { manifest = projectManifestSchema.parse({ ...manifest, workflowState: state, updatedAt: new Date().toISOString() }); await store.writeJson('project.json', projectManifestSchema, manifest); };
  const requireState = (...states: WorkflowState[]) => { if (!states.includes(manifest.workflowState)) throw new Error(`${states.join(' or ')} is required before ${command}`); };
  try {
    switch (command) {
      case 'discover': {
        requireState('DISCOVERED'); if (!deps.topicAdapters?.length) throw new Blocked('BLOCKED_PROVIDER', 'provide --feed <local-topic-feed.json>');
        await discoverTopics(deps.topicAdapters, { count: 5, lane: ['社会观察', '生活态度', '思考辩论'], now: deps.now ?? new Date(), outputPath: join(store.root, 'topic-candidates.json') }); break;
      }
      case 'research': {
        requireState('DISCOVERED', 'RESEARCHED'); if (!deps.sources) throw new Blocked('BLOCKED_EVIDENCE', 'provide --sources <sources.json> with explicit claims');
        const sources = sourcesArtifactSchema.parse({ schemaVersion: 1, sources: deps.sources }).sources;
        const candidates = (await store.readJson('topic-candidates.json', topicCandidatesArtifactSchema)).candidates;
        const index = Number((deps.candidateId ?? 'candidate-1').replace('candidate-', '')) - 1;
        if (!candidates[index]) throw new Blocked('BLOCKED_EVIDENCE', 'choose an existing --candidate candidate-N');
        const brief = buildResearchBrief(candidates[index], sources); await writeResearchArtifacts(brief, sources, { outputDirectory: store.root });
        if (!brief.canDraftScript) throw new Blocked('BLOCKED_EVIDENCE', 'research has unresolved claims or no confirmed facts; correct --sources');
        manifest = projectManifestSchema.parse({ ...manifest, sources });
        await update(manifest.workflowState === 'DISCOVERED' ? transition(transition('DISCOVERED', 'FINISH_DISCOVERY'), 'FINISH_RESEARCH') : transition('RESEARCHED', 'FINISH_RESEARCH')); break;
      }
      case 'approve-topic': {
        requireState('TOPIC_REVIEW_REQUIRED'); const context = await researchContext(store, deps.candidateId);
        if (!context.brief.canDraftScript) throw new Blocked('BLOCKED_EVIDENCE', 'selected topic research is not eligible');
        await approveTopic({ store, manifest, ...context }, deps.candidateId ?? '', deps.actor ?? ''); break;
      }
      case 'draft-script': {
        const context = await researchContext(store); if (!deps.languageModel) throw new Blocked('BLOCKED_PROVIDER', 'provide --draft <ScriptDocument.json>; no live model is configured');
        await buildScript({ store, manifest }, context.brief, deps.languageModel); break;
      }
      case 'approve-script': {
        requireState('SCRIPT_REVIEW_REQUIRED'); const context = await researchContext(store); const draft = await store.readJson('script-draft.json', scriptDocumentSchema);
        await approveScript({ store, manifest, ...context, draft }, deps.actor ?? ''); break;
      }
      case 'voice': {
        requireState('SCRIPT_APPROVED'); const approved = await readApprovedScript(store); const budgetGuard = await hydrateBudget(store, deps.limitCny, deps.currentCallMaxCny);
        const registry = deps.registry ?? ProviderRegistry.detect({});
        let audit;
        try { await readFile(join(store.root, 'voice/audit', attemptId!, 'attempt.json')); audit = await readVoiceAttemptAudit(store, attemptId!); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (audit?.result && audit.attempt.status !== 'OVER_AUTHORIZATION') {
          await generateVoice({ store, registry, budgetGuard, attemptId: attemptId!, requestedScriptHash: approved.scriptHash, probe: await audioProbe(deps) });
          await update(transition(manifest.workflowState, 'GENERATE_VOICE')); break;
        }
        if (audit && audit.attempt.status !== 'RESERVED') throw new Blocked('BLOCKED_PROVIDER', `voice attempt ${attemptId} requires manual provider reconciliation; retry will not issue a new paid call`);
        const auth = { schemaVersion: 1, authorization: 'synthetic', voiceId: 'alloy', identifier: 'synthetic:voice:alloy' };
        const request: TtsRequest = { idempotencyKey: `voice:${manifest.id}:${approved.scriptHash}:${attemptId}`, approvedScriptHash: approved.scriptHash, text: scriptNarrationText(approved.script), voiceId: 'alloy', voiceKind: 'synthetic', authorization: 'synthetic', authorizationReference: auth.identifier, authorizationHash: hashCanonicalJson(auth), outputPath: join(store.root, 'voice/transactions', attemptId!, 'master.tmp.wav') };
        const adapter = await registry.selectAvailableTts(request); const estimate = costRecordSchema.parse(await adapter.estimate(request)); deps.print?.(`Estimate: ${estimate.amount} CNY (${estimate.providerId}; ${estimate.basis})`);
        if (adapter.mode === 'manual') { await createManualVoicePackage({ store, requestedScriptHash: approved.scriptHash }); throw new Blocked('BLOCKED_PROVIDER', 'manual narration package prepared; use import-voice --audio <file> --rights <rights.json>'); }
        if (deps.dryRun || deps.limitCny === undefined && deps.currentCallMaxCny === undefined) throw new Blocked('BLOCKED_PROVIDER', 'dry-run only; configure --budget-cny or --approve-cost-cny and explicit --consent-by/--consent-reference');
        if (deps.currentCallMaxCny !== undefined && estimate.amount > deps.currentCallMaxCny) throw new Blocked('BLOCKED_PROVIDER', 'estimate exceeds current-call approval');
        const consent = z.object({ actor: z.string().trim().min(1), reference: z.string().trim().min(1) }).parse(deps.consent);
        await store.appendEvent({ id: randomUUID(), type: 'PROVIDER_CONSENT', occurredAt: new Date().toISOString(), data: { ...consent, providerId: adapter.id, attemptId, estimate, currentCallMaxCny: deps.currentCallMaxCny } });
        const result = await generateVoice({ store, registry, budgetGuard, attemptId: attemptId!, requestedScriptHash: approved.scriptHash, probe: await audioProbe(deps), converter: deps.converter });
        if (result.status !== 'READY') throw new Blocked('BLOCKED_PROVIDER', 'manual narration required; use import-voice');
        await update(transition(manifest.workflowState, 'GENERATE_VOICE')); break;
      }
      case 'import-voice': {
        requireState('SCRIPT_APPROVED'); if (!deps.audioPath || !deps.authorization) throw new Blocked('BLOCKED_PERMISSION', 'provide --audio <file> --rights <rights.json>');
        const approved = await readApprovedScript(store); const tools = deps.converter && deps.probe ? deps : await resolveManagedMediaTools();
        await importManualVoice({ store, attemptId: randomUUID(), requestedScriptHash: approved.scriptHash, audioPath: deps.audioPath, authorization: deps.authorization, probe: tools.probe!, converter: tools.converter! });
        await update(transition(manifest.workflowState, 'GENERATE_VOICE')); break;
      }
      case 'edit-plan': {
        requireState('VOICE_READY'); const assets = deps.assets ?? { schemaVersion: 1, projectId: manifest.id, assets: [] };
        await store.writeJson('asset-manifest.json', assetManifestSchema, assets); await writeEditPlan(store, await audioProbe(deps), assets); await update(transition(manifest.workflowState, 'BUILD_EDIT_PLAN')); break;
      }
      case 'render': {
        requireState('EDIT_PLAN_READY'); const result = await (deps.render ?? renderVideo)(store.root);
        const voice = await readCommittedVoice(store, await audioProbe(deps));
        if (result.outputPath !== join(store.root, 'output/final.mp4') || result.durationMs !== voice.report.durationMs) throw new Error('renderer output must match expected path and voice duration');
        assertRenderedMedia(await (deps.probeMedia ?? probeMedia)(await boundedLocalFile(store.root, 'output/final.mp4')), voice.report.durationMs);
        await update(transition(manifest.workflowState, 'RENDER')); break;
      }
      case 'qc': {
        requireState('RENDERED'); const report = await inspectQc(store.root, deps); await persistQc(store.root, report);
        if (report.status !== 'QC_PASSED') throw new Blocked('FAILED_QC', report.errors.map(e => `${e.check}: ${e.message}`).join('; '));
        await update(transition(manifest.workflowState, 'PASS_QC')); break;
      }
      case 'finish': requireState('QC_PASSED'); await update(transition(manifest.workflowState, 'FINISH')); break;
    }
    const current = await store.readJson('project.json', projectManifestSchema); await saveJournal(store, old, current.workflowState, command, inputHash, 'stage completed', attemptId); return current.workflowState;
  } catch (error) {
    if (command === 'approve-topic' || command === 'approve-script') {
      // Explicit recovery of a torn approval promotion only. Do not reset a valid approval.
      // The prior review state was parsed and validated before this invocation.
      try { if (command === 'approve-topic') await readApprovedTopic(store); else await readApprovedScript(store); }
      catch { await store.writeJson('project.json', projectManifestSchema, previousManifest); }
    }
    const state: WorkflowState = error instanceof Blocked ? error.state : command === 'render' ? 'FAILED_RENDER' : command === 'qc' ? 'FAILED_QC' : ['voice', 'draft-script', 'discover'].includes(command) ? 'BLOCKED_PROVIDER' : command === 'import-voice' || command === 'edit-plan' ? 'BLOCKED_PERMISSION' : 'BLOCKED_EVIDENCE';
    await saveJournal(store, old, state, command, inputHash, error instanceof Error ? error.message : String(error), attemptId); deps.print?.(error instanceof Error ? error.message : String(error)); return state;
  }
}
