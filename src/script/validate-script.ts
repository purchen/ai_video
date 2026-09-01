import type { ResearchBrief } from '../research/build-brief';
import {
  scriptDocumentSchema,
  scriptSectionOrder,
  validateEvidenceBindings,
  type ScriptDocument,
  type SourceRecord,
} from '../domain/schemas';

export interface ScriptValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateScript(
  input: unknown,
  brief?: ResearchBrief,
  explicitSources?: SourceRecord[],
): ScriptValidationResult {
  const errors: string[] = [];
  const parsed = scriptDocumentSchema.safeParse(input);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(issue.message);
    }
  }

  if (!isRecord(input)) return result(errors);

  const estimatedDurationMs = input.estimatedDurationMs;
  if (typeof estimatedDurationMs !== 'number' || estimatedDurationMs < 60_000 || estimatedDurationMs > 120_000) {
    errors.push('estimated duration must be between 60000 and 120000 ms');
  }

  const sections = Array.isArray(input.sections) ? input.sections : [];
  const actualOrder = sections.map((section) => isRecord(section) ? section.type : undefined);
  if (actualOrder.length !== scriptSectionOrder.length
    || actualOrder.some((value, index) => value !== scriptSectionOrder[index])) {
    errors.push('script sections must follow the required seven-section order');
  }

  const sentences = Array.isArray(input.sentences) ? input.sentences : [];
  if (!brief && !explicitSources && sentences.some((sentence) => isRecord(sentence) && sentence.type === 'fact')) {
    errors.push('fact evidence context is required');
  }
  for (const sentence of sentences) {
    if (!isRecord(sentence) || typeof sentence.id !== 'string') continue;
    const sourceIds = Array.isArray(sentence.sourceIds) ? sentence.sourceIds : [];
    if (sentence.type === 'fact') {
      if (sourceIds.length === 0) errors.push(`fact sentence ${sentence.id} requires at least one source`);
      if (typeof sentence.attribution !== 'string' || sentence.attribution.trim() === '') {
        errors.push(`fact sentence ${sentence.id} requires attribution`);
      }
    }
    if (sentence.type === 'opinion' && sourceIds.length > 0) {
      errors.push(`opinion sentence ${sentence.id} must not carry factual source ids`);
    }
  }

  const mechanism = sections.find((section) => isRecord(section) && section.type === 'mechanism');
  if (isRecord(mechanism)) {
    const lenses = Array.isArray(mechanism.lenses) ? mechanism.lenses : [];
    if (lenses.length > 2) errors.push('mechanism section may use at most two lenses');
    if (brief) {
      for (const lens of lenses) {
        if (typeof lens === 'string' && !brief.candidateLenses.includes(lens)) {
          errors.push(`mechanism lens ${lens} is not present in the research brief`);
        }
      }
    }
  }

  if (parsed.success) {
    const sources = explicitSources ?? (brief ? sourcesFromBrief(brief) : undefined);
    if (sources) {
      try {
        validateEvidenceBindings(sources, parsed.data.sentences);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Invalid factual evidence bindings');
      }
    }

    const sentenceIds = new Set(parsed.data.sentences.map((sentence) => sentence.id));
    for (const section of parsed.data.sections) {
      for (const sentenceId of section.sentenceIds) {
        if (!sentenceIds.has(sentenceId)) errors.push(`section ${section.type} references unknown sentence ${sentenceId}`);
      }
    }
  }

  return result(errors);
}

export function assertValidScript(
  input: unknown,
  brief?: ResearchBrief,
  sources?: SourceRecord[],
): asserts input is ScriptDocument {
  const validation = validateScript(input, brief, sources);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
}

function sourcesFromBrief(brief: ResearchBrief): SourceRecord[] {
  const sourceIds = [...new Set(brief.confirmedFacts.flatMap((fact) => fact.sourceIds))];
  return sourceIds.map((id) => ({
    schemaVersion: 1,
    id,
    url: `https://evidence.invalid/${encodeURIComponent(id)}`,
    title: id,
    publisher: 'Research brief',
    summary: 'Confirmed fact source from the research brief.',
    sourceType: 'primary',
    evidenceWeight: 'high',
    capturedAt: '1970-01-01T00:00:00.000Z',
  }));
}

function result(errors: string[]): ScriptValidationResult {
  const uniqueErrors = [...new Set(errors)];
  return { valid: uniqueErrors.length === 0, errors: uniqueErrors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
