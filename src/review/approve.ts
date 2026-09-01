import { z } from 'zod';
import {
  projectManifestSchema,
  scriptDocumentSchema,
  type ProjectManifest,
  type ScriptDocument,
} from '../domain/schemas';
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
  candidateId: z.string().min(1),
  approvedAt: z.string().datetime(),
  approvedBy: z.string().min(1),
  candidate: topicCandidateSchema,
});

export const approvedScriptSchema = z.object({
  schemaVersion: z.literal(1),
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
  approvalType: z.enum(['topic', 'script']),
  projectId: z.string().min(1),
  artifactName: z.enum(['topic-card.json', 'approved-script.json']),
  artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
  expectedWorkflowState: z.enum(['TOPIC_APPROVED', 'SCRIPT_APPROVED']),
  committedAt: z.string().datetime(),
});

export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

export interface ApprovedScript {
  schemaVersion: 1;
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

  const approval = approvalRecordSchema.parse({
    schemaVersion: 1,
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
  const commit = approvalCommitSchema.parse({
    schemaVersion: 1,
    approvalType: 'topic',
    projectId: manifest.id,
    artifactName: 'topic-card.json',
    artifactHash: hashCanonicalJson(approval),
    expectedWorkflowState: 'TOPIC_APPROVED',
    committedAt: approval.approvedAt,
  });

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
  assertValidScript(draft, project.brief, project.manifest.sources);
  const approvedAt = new Date().toISOString();
  const approved = approvedScriptSchema.parse({
    schemaVersion: 1,
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
  const commit = approvalCommitSchema.parse({
    schemaVersion: 1,
    approvalType: 'script',
    projectId: manifest.id,
    artifactName: 'approved-script.json',
    artifactHash: hashCanonicalJson(approved),
    expectedWorkflowState: 'SCRIPT_APPROVED',
    committedAt: approvedAt,
  });

  await project.store.writeJson('approved-script.json', approvedScriptSchema, approved);
  await project.store.writeJson('project.json', projectManifestSchema, manifest);
  await project.store.writeJson('script-approval.commit.json', approvalCommitSchema, commit);
  project.manifest = manifest;
  return deepFreeze(approved);
}

export async function readApprovedTopic(store: ProjectStore): Promise<ApprovalRecord> {
  const commit = await readCommit(store, 'topic-approval.commit.json', 'topic');
  const approval = await store.readJson('topic-card.json', approvalRecordSchema);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  assertCommitMatches(commit, manifest, 'topic-card.json', hashCanonicalJson(approval), 'TOPIC_APPROVED');
  if (manifest.topic !== approval.candidate.title) throw new Error('topic approval does not match project topic');
  return deepFreeze(approval);
}

export async function readApprovedScript(store: ProjectStore): Promise<ApprovedScript> {
  const commit = await readCommit(store, 'script-approval.commit.json', 'script');
  const approved = await store.readJson('approved-script.json', approvedScriptSchema);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  assertCommitMatches(commit, manifest, 'approved-script.json', hashCanonicalJson(approved), 'SCRIPT_APPROVED');
  if (!manifest.script || hashScript(manifest.script) !== approved.scriptHash) {
    throw new Error('approved script does not match the committed project script');
  }
  return deepFreeze(approved);
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

function assertCommitMatches(
  commit: z.infer<typeof approvalCommitSchema>,
  manifest: ProjectManifest,
  artifactName: 'topic-card.json' | 'approved-script.json',
  artifactHash: string,
  expectedWorkflowState: 'TOPIC_APPROVED' | 'SCRIPT_APPROVED',
): void {
  if (commit.projectId !== manifest.id
    || commit.artifactName !== artifactName
    || commit.artifactHash !== artifactHash
    || commit.expectedWorkflowState !== expectedWorkflowState
    || manifest.workflowState !== expectedWorkflowState) {
    throw new Error(`${commit.approvalType} approval commit does not match artifact and project state`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertActor(actor: string): void {
  if (!actor.trim()) throw new Error('approval actor is required');
}
