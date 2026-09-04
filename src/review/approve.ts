import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  projectManifestSchema,
  scriptDocumentSchema,
  type ProjectManifest,
  type ScriptDocument,
} from '../domain/schemas';
import type { WorkflowState } from '../domain/state-machine';
import type { ResearchBrief } from '../research/build-brief';
import { hashCanonicalJson, hashScript } from '../script/hash-script';
import { assertValidScript } from '../script/validate-script';
import type { ProjectStore } from '../store/project-store';
import type { TopicCandidate } from '../topic/discover';

const topicScoreSchema = z.object({
  relevance: z.number(),
  tension: z.number(),
  evidenceAvailability: z.number(),
  independentJudgment: z.number(),
  laneFit: z.number(),
  visualDifficulty: z.number(),
  risk: z.number(),
  total: z.number(),
});

const topicCandidateSchema = z.object({
  title: z.string().min(1),
  normalizedTopic: z.string().min(1),
  questionHook: z.string().min(1),
  sourceUrls: z.array(z.string().url()),
  sourcePublishers: z.array(z.string().min(1)),
  risks: z.array(z.string()),
  eligibleForRecommendation: z.boolean(),
  score: topicScoreSchema,
});

export const approvalRecordSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  projectId: z.string().min(1),
  candidateId: z.string().min(1),
  approvedAt: z.string().datetime(),
  approvedBy: z.string().min(1),
  candidate: topicCandidateSchema,
});

export const approvedScriptSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  approvedAt: z.string().datetime(),
  approvedBy: z.string().min(1),
  scriptHash: z.string().regex(/^[a-f0-9]{64}$/),
  script: scriptDocumentSchema,
}).superRefine((approved, context) => {
  if (hashScript(approved.script) !== approved.scriptHash) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'approved script hash does not match script content',
      path: ['scriptHash'],
    });
  }
});

const approvalCommitSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: z.string().uuid(),
  approvalType: z.enum(['topic', 'script']),
  projectId: z.string().min(1),
  artifactName: z.enum(['topic-card.json', 'approved-script.json']),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectHash: z.string().regex(/^[a-f0-9]{64}$/),
  projectSnapshot: projectManifestSchema,
  expectedWorkflowState: z.enum(['TOPIC_APPROVED', 'SCRIPT_APPROVED']),
  committedAt: z.string().datetime(),
});

const topicApprovalStates = new Set<WorkflowState>([
  'TOPIC_APPROVED',
  'SCRIPT_DRAFTED',
  'SCRIPT_REVIEW_REQUIRED',
  'SCRIPT_APPROVED',
  'VOICE_READY',
  'EDIT_PLAN_READY',
  'RENDERED',
  'QC_PASSED',
  'COMPLETE',
]);

const scriptApprovalStates = new Set<WorkflowState>([
  'SCRIPT_APPROVED',
  'VOICE_READY',
  'EDIT_PLAN_READY',
  'RENDERED',
  'QC_PASSED',
  'COMPLETE',
]);

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export interface ApprovedScript {
  schemaVersion: 1;
  transactionId: string;
  approvedAt: string;
  approvedBy: string;
  scriptHash: string;
  script: ScriptDocument;
}

export interface ReviewProject {
  store: ProjectStore;
  manifest: ProjectManifest;
  candidates: Array<{ id: string; candidate: TopicCandidate }>;
  draft?: ScriptDocument;
  brief: ResearchBrief;
}

export interface DurableTopicApproval {
  approval: ApprovalRecord;
  manifest: ProjectManifest;
}

export { hashScript } from '../script/hash-script';

/** State guard for the Task 9 orchestrator without introducing run-stage early. */
export function requireTopicApprovalForDraft(project: Pick<ReviewProject, 'manifest'>): void {
  if (project.manifest.workflowState !== 'TOPIC_APPROVED') {
    throw new Error('TOPIC_APPROVED is required before DRAFT_SCRIPT');
  }
}

export async function approveTopic(
  project: ReviewProject,
  candidateId: string,
  actor: string,
): Promise<ApprovalRecord> {
  assertActor(actor);
  if (project.manifest.workflowState !== 'TOPIC_REVIEW_REQUIRED') {
    throw new Error('TOPIC_REVIEW_REQUIRED is required before APPROVE_TOPIC');
  }

  const selected = project.candidates.find((entry) => entry.id === candidateId);
  if (!selected) throw new Error(`topic candidate ${candidateId} was not found`);

  const transactionId = randomUUID();
  const approval = approvalRecordSchema.parse({
    schemaVersion: 1,
    transactionId,
    projectId: project.manifest.id,
    candidateId,
    approvedAt: new Date().toISOString(),
    approvedBy: actor.trim(),
    candidate: selected.candidate,
  });
  const manifest = projectManifestSchema.parse({
    ...project.manifest,
    topic: selected.candidate.title,
    workflowState: 'TOPIC_APPROVED',
    updatedAt: approval.approvedAt,
  });
  const commit = createCommit(
    transactionId,
    'topic',
    'topic-card.json',
    approval,
    manifest,
    'TOPIC_APPROVED',
    approval.approvedAt,
  );

  await project.store.writeJson('topic-card.json', approvalRecordSchema, approval);
  await project.store.writeJson('project.json', projectManifestSchema, manifest);
  await project.store.writeJson('topic-approval.commit.json', approvalCommitSchema, commit);
  project.manifest = manifest;
  return deepFreeze(approval);
}

export async function approveScript(project: ReviewProject, actor: string): Promise<ApprovedScript> {
  assertActor(actor);
  if (project.manifest.workflowState !== 'SCRIPT_REVIEW_REQUIRED') {
    throw new Error('SCRIPT_REVIEW_REQUIRED is required before APPROVE_SCRIPT');
  }

  const draft = scriptDocumentSchema.parse(project.draft ?? project.manifest.script);
  if (draft.projectId !== project.manifest.id) {
    throw new Error('script projectId must match project manifest id');
  }
  assertValidScript(draft, project.brief, project.manifest.sources);
  const transactionId = randomUUID();
  const approvedAt = new Date().toISOString();
  const approved = approvedScriptSchema.parse({
    schemaVersion: 1,
    transactionId,
    approvedAt,
    approvedBy: actor.trim(),
    scriptHash: hashScript(draft),
    script: draft,
  });
  const manifest = projectManifestSchema.parse({
    ...project.manifest,
    workflowState: 'SCRIPT_APPROVED',
    updatedAt: approvedAt,
    script: draft,
  });
  const commit = createCommit(
    transactionId,
    'script',
    'approved-script.json',
    approved,
    manifest,
    'SCRIPT_APPROVED',
    approvedAt,
  );

  await project.store.writeJson('approved-script.json', approvedScriptSchema, approved);
  await project.store.writeJson('project.json', projectManifestSchema, manifest);
  await project.store.writeJson('script-approval.commit.json', approvalCommitSchema, commit);
  project.manifest = manifest;
  return deepFreeze(approved);
}

export async function readApprovedTopic(store: ProjectStore): Promise<ApprovalRecord> {
  return (await readApprovedTopicSnapshot(store)).approval;
}

export async function readApprovedTopicSnapshot(store: ProjectStore): Promise<DurableTopicApproval> {
  const commit = await readCommit(store, 'topic-approval.commit.json', 'topic');
  const approval = await store.readJson('topic-card.json', approvalRecordSchema);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  assertCommitBinding(commit, manifest, approval, 'topic-card.json', 'TOPIC_APPROVED', topicApprovalStates);
  if (approval.projectId !== manifest.id || approval.projectId !== commit.projectSnapshot.id) {
    throw new Error('topic approval projectId does not match project manifest id');
  }
  if (manifest.topic !== approval.candidate.title || commit.projectSnapshot.topic !== approval.candidate.title) {
    throw new Error('topic approval does not match project topic');
  }
  return deepFreeze({ approval, manifest });
}

export async function readApprovedScript(store: ProjectStore): Promise<ApprovedScript> {
  const commit = await readCommit(store, 'script-approval.commit.json', 'script');
  const approved = await store.readJson('approved-script.json', approvedScriptSchema);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  if (approved.script.projectId !== manifest.id || approved.script.projectId !== commit.projectSnapshot.id) {
    throw new Error('approved script projectId does not match project manifest id');
  }
  assertCommitBinding(
    commit,
    manifest,
    approved,
    'approved-script.json',
    'SCRIPT_APPROVED',
    scriptApprovalStates,
  );
  if (!manifest.script || hashScript(manifest.script) !== approved.scriptHash) {
    throw new Error('approved script does not match the committed project script');
  }
  return deepFreeze(approved);
}

function createCommit(
  transactionId: string,
  approvalType: 'topic' | 'script',
  artifactName: 'topic-card.json' | 'approved-script.json',
  artifact: ApprovalRecord | ApprovedScript,
  manifest: ProjectManifest,
  expectedWorkflowState: 'TOPIC_APPROVED' | 'SCRIPT_APPROVED',
  committedAt: string,
): z.infer<typeof approvalCommitSchema> {
  return approvalCommitSchema.parse({
    schemaVersion: 1,
    transactionId,
    approvalType,
    projectId: manifest.id,
    artifactName,
    artifactHash: hashCanonicalJson(artifact),
    projectHash: hashCanonicalJson(manifest),
    projectSnapshot: manifest,
    expectedWorkflowState,
    committedAt,
  });
}

async function readCommit(
  store: ProjectStore,
  name: 'topic-approval.commit.json' | 'script-approval.commit.json',
  approvalType: 'topic' | 'script',
): Promise<z.infer<typeof approvalCommitSchema>> {
  try {
    const commit = await store.readJson(name, approvalCommitSchema);
    if (commit.approvalType !== approvalType) throw new Error('wrong approval type');
    return commit;
  } catch {
    throw new Error(`${approvalType} approval is not committed`);
  }
}

function assertCommitBinding(
  commit: z.infer<typeof approvalCommitSchema>,
  manifest: ProjectManifest,
  artifact: ApprovalRecord | ApprovedScript,
  artifactName: 'topic-card.json' | 'approved-script.json',
  expectedWorkflowState: 'TOPIC_APPROVED' | 'SCRIPT_APPROVED',
  allowedStates: Set<WorkflowState>,
): void {
  const artifactTransactionId = artifact.transactionId;
  const snapshot = commit.projectSnapshot;
  const currentState = manifest.workflowState;
  const sameApprovalState = currentState === expectedWorkflowState;
  const validCurrentProject = sameApprovalState
    ? hashCanonicalJson(manifest) === commit.projectHash
    : allowedStates.has(currentState) && stableProjectIdentityMatches(snapshot, manifest);

  if (commit.transactionId !== artifactTransactionId
    || commit.projectId !== manifest.id
    || commit.projectId !== snapshot.id
    || commit.artifactName !== artifactName
    || commit.artifactHash !== hashCanonicalJson(artifact)
    || commit.projectHash !== hashCanonicalJson(snapshot)
    || commit.expectedWorkflowState !== expectedWorkflowState
    || snapshot.workflowState !== expectedWorkflowState
    || !validCurrentProject) {
    throw new Error(`${commit.approvalType} approval commit does not match artifact and project state`);
  }
}

function stableProjectIdentityMatches(snapshot: ProjectManifest, current: ProjectManifest): boolean {
  return snapshot.schemaVersion === current.schemaVersion
    && snapshot.id === current.id
    && snapshot.topic === current.topic
    && snapshot.createdAt === current.createdAt
    && hashCanonicalJson(snapshot.sources) === hashCanonicalJson(current.sources);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertActor(actor: string): void {
  if (!actor.trim()) throw new Error('approval actor is required');
}
