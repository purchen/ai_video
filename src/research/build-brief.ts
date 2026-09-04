import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { sourceRecordSchema, type SourceRecord } from '../domain/schemas';
import type { TopicCandidate } from '../topic/discover';
import { classifySource } from './classify-source';

const claimSchema = z.object({
  /** A stable, human-authored identifier for exactly one proposition. */
  key: z.string().min(1),
  /** The source's explicit position on that proposition. */
  value: z.enum(['affirmed', 'denied']),
  /** The concise proposition shown in the brief. */
  text: z.string().min(1),
});

export type ExplicitClaim = z.infer<typeof claimSchema>;
export type ResearchSource = SourceRecord & { claim?: ExplicitClaim };

const researchSourceSchema = sourceRecordSchema.extend({ claim: claimSchema.optional() });
export const researchLensSchema = z.object({
  id: z.string().trim().min(1), label: z.string().trim().min(1), text: z.string().trim().min(1),
  basis: z.enum(['source', 'everyday-common-sense']), sourceIds: z.array(z.string().trim().min(1)),
  applicability: z.string().trim().min(1),
}).strict().superRefine((lens, context) => {
  if ((lens.basis === 'source') !== (lens.sourceIds.length > 0)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'source lens needs sources; common-sense lens must remain non-evidentiary' });
});
export type ResearchLens = z.infer<typeof researchLensSchema>;
export const researchLensesSchema = z.array(researchLensSchema).max(2).superRefine((lenses, context) => {
  if (new Set(lenses.map(l => l.id)).size !== lenses.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'chosen lens ids must be unique' });
});
export const sourcesArtifactSchema = z.object({ schemaVersion: z.literal(1), sources: z.array(researchSourceSchema), lenses: researchLensesSchema.optional() });
const everydayCommonSenseNoteSchema = z.object({
  kind: z.literal('everyday-common-sense'),
  text: z.string().min(1),
  lens: z.string().min(1).optional(),
});

export interface ConfirmedFact {
  claimKey: string;
  value: ExplicitClaim['value'];
  text: string;
  sourceIds: string[];
}

export interface ClaimConflict {
  claimKey: string;
  sourceIds: string[];
  resolution: 'unresolved';
}

export interface SourceExplanationNote {
  sourceId: string;
  text: string;
}

export type EverydayCommonSenseExplanationNote = z.infer<typeof everydayCommonSenseNoteSchema>;
export type ExplanationNote = SourceExplanationNote | EverydayCommonSenseExplanationNote;

export interface ResearchBrief {
  topic: Pick<TopicCandidate, 'title' | 'normalizedTopic' | 'questionHook'>;
  confirmedFacts: ConfirmedFact[];
  conflicts: ClaimConflict[];
  unknowns: string[];
  candidateLenses: string[];
  chosenLenses: ResearchLens[];
  risks: string[];
  publicQuestions: string[];
  explanationNotes: ExplanationNote[];
  canDraftScript: boolean;
  status: 'RESEARCHED' | 'BLOCKED_EVIDENCE';
}

export interface ResearchArtifactOptions {
  outputDirectory: string;
}

export interface BuildResearchBriefOptions {
  lenses?: ResearchLens[];
  /**
   * Non-evidentiary context for framing a lens. It is intentionally separate
   * from source records and can never create facts or conflicts.
   */
  explanationNotes?: EverydayCommonSenseExplanationNote[];
}

/**
 * Builds a deterministic brief from explicit claims. A claim needs key, value,
 * and text; title and summary are never interpreted as claims.
 */
export function buildResearchBrief(
  topic: TopicCandidate,
  sources: ResearchSource[],
  options: BuildResearchBriefOptions = {},
): ResearchBrief {
  const validatedSources = sources.map((source) => researchSourceSchema.parse(source));
  const chosenLenses = researchLensesSchema.parse(options.lenses ?? []);
  for (const lens of chosenLenses) for (const id of lens.sourceIds) {
    const source = validatedSources.find(s => s.id === id);
    if (!source || source.sourceType === 'comment-sample') throw new Error(`lens ${lens.id} requires a resolvable non-comment source ${id}`);
  }
  const commonSenseNotes = (options.explanationNotes ?? []).map((note) => everydayCommonSenseNoteSchema.parse(note));
  const factClaims = validatedSources.filter(hasFactClaim);
  const conflicts = detectConflicts(factClaims);
  const conflictedKeys = new Set(conflicts.map((conflict) => conflict.claimKey));
  const confirmedFacts = summarizeFacts(factClaims, conflictedKeys);
  const publicQuestions = validatedSources
    .filter((source) => classifySource(source).allowedUses.includes('public-question'))
    .map((source) => source.summary)
    .sort(lexical);
  const sourceExplanationNotes: SourceExplanationNote[] = validatedSources
    .filter((source) => classifySource(source).allowedUses.includes('mechanism'))
    .map((source) => ({ sourceId: source.id, text: source.claim?.text ?? source.summary }))
    .sort((left, right) => lexical(left.sourceId, right.sourceId));
  const explanationNotes = [...sourceExplanationNotes, ...commonSenseNotes];
  const unknowns = [
    ...conflicts.map((conflict) => `Unresolved claim: ${conflict.claimKey}`),
    ...(confirmedFacts.length === 0 ? ['No supported, explicit event claim is confirmed.'] : []),
    ...(chosenLenses.length === 0 ? ['Choose one or two relevant lenses with explicit explanation and applicability limits.'] : []),
  ];
  const risks = [...new Set([
    ...topic.risks,
    ...conflicts.map((conflict) => `unresolved-conflict:${conflict.claimKey}`),
  ])].sort(lexical);
  const canDraftScript = conflicts.length === 0 && confirmedFacts.length > 0 && chosenLenses.length >= 1;

  return {
    topic: { title: topic.title, normalizedTopic: topic.normalizedTopic, questionHook: topic.questionHook },
    confirmedFacts,
    conflicts,
    unknowns,
    candidateLenses: chosenLenses.map(lens => lens.id),
    chosenLenses,
    risks,
    publicQuestions,
    explanationNotes,
    canDraftScript,
    status: canDraftScript ? 'RESEARCHED' : 'BLOCKED_EVIDENCE',
  };
}

export async function writeResearchArtifacts(
  brief: ResearchBrief,
  sources: ResearchSource[],
  options: ResearchArtifactOptions,
): Promise<void> {
  const sourceArtifact = sourcesArtifactSchema.parse({ schemaVersion: 1, sources, lenses: brief.chosenLenses });
  await mkdir(options.outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(options.outputDirectory, 'sources.json'), `${JSON.stringify(sourceArtifact, null, 2)}\n`, 'utf8'),
    writeFile(join(options.outputDirectory, 'research-brief.md'), renderResearchBrief(brief), 'utf8'),
  ]);
}

function detectConflicts(sources: Array<ResearchSource & { claim: ExplicitClaim }>): ClaimConflict[] {
  const byKey = new Map<string, Array<ResearchSource & { claim: ExplicitClaim }>>();
  for (const source of sources) {
    const entries = byKey.get(source.claim.key) ?? [];
    entries.push(source);
    byKey.set(source.claim.key, entries);
  }

  return [...byKey.entries()]
    .filter(([, entries]) => new Set(entries.map((entry) => entry.claim.value)).size > 1)
    .map(([claimKey, entries]) => ({
      claimKey,
      sourceIds: entries.map((entry) => entry.id).sort(lexical),
      resolution: 'unresolved' as const,
    }))
    .sort((left, right) => lexical(left.claimKey, right.claimKey));
}

function hasFactClaim(source: ResearchSource): source is ResearchSource & { claim: ExplicitClaim } {
  return source.claim !== undefined && classifySource(source).allowedUses.includes('fact');
}

function summarizeFacts(
  sources: Array<ResearchSource & { claim: ExplicitClaim }>,
  conflictedKeys: Set<string>,
): ConfirmedFact[] {
  const byClaim = new Map<string, Array<ResearchSource & { claim: ExplicitClaim }>>();
  for (const source of sources) {
    if (conflictedKeys.has(source.claim.key)) continue;
    const key = `${source.claim.key}\u0000${source.claim.value}`;
    const entries = byClaim.get(key) ?? [];
    entries.push(source);
    byClaim.set(key, entries);
  }

  return [...byClaim.values()]
    .map((entries) => ({
      claimKey: entries[0].claim.key,
      value: entries[0].claim.value,
      text: entries[0].claim.text,
      sourceIds: entries.map((entry) => entry.id).sort(lexical),
    }))
    .sort((left, right) => lexical(left.claimKey, right.claimKey) || lexical(left.value, right.value));
}

function renderResearchBrief(brief: ResearchBrief): string {
  return [
    `# Research brief: ${brief.topic.title}`,
    '',
    `Status: ${brief.status}`,
    `Can draft script: ${brief.canDraftScript ? 'yes' : 'no'}`,
    '',
    '## Confirmed facts',
    ...renderItems(brief.confirmedFacts.map((fact) => `${fact.text} [${fact.sourceIds.join(', ')}]`)),
    '',
    '## Conflicts',
    ...renderItems(brief.conflicts.map((conflict) => `${conflict.claimKey}: ${conflict.resolution} [${conflict.sourceIds.join(', ')}]`)),
    '',
    '## Unknowns',
    ...renderItems(brief.unknowns),
    '',
    '## Candidate lenses',
    ...renderItems(brief.chosenLenses.map(lens => `${lens.id} (${lens.label}): ${lens.text} [${lens.basis}; ${lens.sourceIds.join(', ')}]; applicability: ${lens.applicability}`)),
    '',
    '## Risks',
    ...renderItems(brief.risks),
    '',
    '## Public questions',
    ...renderItems(brief.publicQuestions),
    '',
    '## Explanation notes',
    ...renderItems(brief.explanationNotes.map(renderExplanationNote)),
    '',
  ].join('\n');
}

function renderItems(items: string[]): string[] {
  return items.length > 0 ? items.map((item) => `- ${item}`) : ['- None'];
}

function renderExplanationNote(note: ExplanationNote): string {
  if ('sourceId' in note) return `${note.text} [${note.sourceId}]`;
  return note.lens ? `${note.text} [everyday-common-sense; ${note.lens}]` : `${note.text} [everyday-common-sense]`;
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
