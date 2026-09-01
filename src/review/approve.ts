import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  projectManifestSchema,
  scriptDocumentSchema,
  type ProjectManifest,
  type ScriptDocument,
} from '../domain/schemas';
import type { ProjectStore } from '../store/project-store';
import type { TopicCandidate } from '../topic/discover';
import { assertValidScript } from '../script/validate-script';

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
}

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

  await project.store.writeJson('topic-card.json', approvalRecordSchema, approval);
  await project.store.writeJson('project.json', projectManifestSchema, manifest);
  project.manifest = manifest;
  return approval;
}

export async function approveScript(project: ReviewProject, actor: string): Promise<ApprovedScript> {
  assertActor(actor);
  if (project.manifest.workflowState !== 'SCRIPT_REVIEW_REQUIRED') {
    throw new Error('SCRIPT_REVIEW_REQUIRED is required before APPROVE_SCRIPT');
  }

  const draft = scriptDocumentSchema.parse(project.draft ?? project.manifest.script);
  assertValidScript(draft, undefined, project.manifest.sources);
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

  await project.store.writeJson('approved-script.json', approvedScriptSchema, approved);
  await project.store.writeJson('project.json', projectManifestSchema, manifest);
  project.manifest = manifest;
  return deepFreeze(approved);
}

export function hashScript(script: unknown): string {
  const validated = scriptDocumentSchema.parse(script);
  return createHash('sha256').update(canonicalJson(validated)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertActor(actor: string): void {
  if (!actor.trim()) throw new Error('approval actor is required');
}
