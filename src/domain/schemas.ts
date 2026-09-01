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

export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const scriptSentenceSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  type: z.enum(['hook', 'fact', 'opinion', 'transition', 'call-to-action']),
  sourceIds: z.array(z.string().min(1)),
  attribution: z.string().min(1).optional(),
}).superRefine((sentence, context) => {
  if (sentence.type === 'fact' && sentence.sourceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Factual sentences require at least one source ID',
      path: ['sourceIds'],
    });
  }
});

export type ScriptSentence = z.infer<typeof scriptSentenceSchema>;

export const scriptSectionOrder = [
  'question-hook',
  'fact-baseline',
  'strong-evidence',
  'mechanism',
  'counter-evidence',
  'judgment',
  'closing-question',
] as const;

export const scriptSectionTypeSchema = z.enum(scriptSectionOrder);

export const scriptSectionSchema = z.object({
  type: scriptSectionTypeSchema,
  sentenceIds: z.array(z.string().min(1)).min(1),
  lenses: z.array(z.string().min(1)),
});

export const scriptDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  sections: z.array(scriptSectionSchema),
  sentences: z.array(scriptSentenceSchema),
  estimatedDurationMs: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).superRefine((script, context) => {
  if (script.sections.length !== scriptSectionOrder.length
    || script.sections.some((section, index) => section.type !== scriptSectionOrder[index])) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'script sections must follow the required seven-section order',
      path: ['sections'],
    });
  }
});

export type ScriptDocument = z.infer<typeof scriptDocumentSchema>;

export function validateEvidenceBindings(sources: SourceRecord[], sentences: ScriptSentence[]): void {
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  for (const sentence of sentences) {
    if (sentence.type !== 'fact') continue;

    for (const sourceId of sentence.sourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) throw new Error(`Factual sentence references unknown source ${sourceId}`);
      if (source.sourceType === 'comment-sample') {
        throw new Error(`Factual sentence cannot use comment-sample source ${sourceId}`);
      }
    }
  }
}

export const projectManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  topic: z.string().min(1),
  workflowState: workflowStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sources: z.array(sourceRecordSchema),
  script: scriptDocumentSchema.optional(),
}).superRefine((project, context) => {
  if (!project.script) return;

  try {
    validateEvidenceBindings(project.sources, project.script.sentences);
  } catch (error) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : 'Invalid factual evidence bindings',
      path: ['script', 'sentences'],
    });
  }
});

export const projectEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  occurredAt: z.string().datetime(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const persistedProjectEventSchema = projectEventSchema.extend({
  schemaVersion: z.literal(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type ProjectEvent = z.infer<typeof projectEventSchema>;
