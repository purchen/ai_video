import { z } from 'zod';

export const workflowStateSchema = z.enum([
  'DISCOVERED', 'RESEARCHED', 'TOPIC_REVIEW_REQUIRED', 'TOPIC_APPROVED',
  'SCRIPT_DRAFTED', 'SCRIPT_REVIEW_REQUIRED', 'SCRIPT_APPROVED',
  'VOICE_READY', 'EDIT_PLAN_READY', 'RENDERED', 'QC_PASSED', 'COMPLETE',
  'BLOCKED_EVIDENCE', 'BLOCKED_PERMISSION', 'BLOCKED_PROVIDER',
  'FAILED_RENDER', 'FAILED_QC',
]);

export const sourceRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  summary: z.string().min(1),
  publishedAt: z.string().datetime().optional(),
  sourceType: z.enum(['primary', 'official-data', 'professional-media', 'expert-analysis', 'comment-sample']),
  evidenceWeight: z.enum(['high', 'medium-high', 'medium', 'low']),
  capturedAt: z.string().datetime(),
});

export const scriptSentenceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  type: z.enum(['hook', 'fact', 'opinion', 'transition', 'call-to-action']),
  sourceIds: z.array(z.string().min(1)),
});

export const scriptDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  sentences: z.array(scriptSentenceSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const projectManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  topic: z.string().min(1),
  workflowState: workflowStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sources: z.array(sourceRecordSchema),
  script: scriptDocumentSchema.optional(),
});

export type SourceRecord = z.infer<typeof sourceRecordSchema>;
export type ScriptSentence = z.infer<typeof scriptSentenceSchema>;
export type ScriptDocument = z.infer<typeof scriptDocumentSchema>;
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
