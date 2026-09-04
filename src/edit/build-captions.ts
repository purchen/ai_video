import { z } from 'zod';
import { scriptDocumentSchema, type ScriptDocument } from '../domain/schemas';
import { hashScript } from '../script/hash-script';
import { scriptNarrationText } from '../script/narration';
import { wordTimingsSchema, type WordTimings } from '../voice/schemas';

export const captionCueSchema = z.object({
  schemaVersion: z.literal(1),
  scriptSentenceId: z.string().min(1),
  text: z.string().min(1).refine(t => [...t.replace(/\n/g, '')].length <= 18 && t.split('\n').length <= 2, 'caption exceeds 18 characters/two lines'),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
}).refine(c => c.endMs - c.startMs >= 700, 'caption requires at least 700 ms');
export type CaptionCue = z.infer<typeof captionCueSchema>;

/** Only punctuation and narration line breaks are display-normalized. Spaces and words are retained. */
export function captionCharacters(text: string): string {
  return text.replace(/[\p{P}\r\n]/gu, '');
}

export function buildCaptions(scriptInput: ScriptDocument, timingInput: WordTimings, options: { durationMs: number }): CaptionCue[] {
  const script = scriptDocumentSchema.parse(scriptInput);
  scriptNarrationText(script); // Enforce canonical sentence topology, not array order.
  const timings = wordTimingsSchema.parse(timingInput);
  const durationMs = z.number().int().positive().parse(options.durationMs);
  if (timings.projectId !== script.projectId || timings.approvedScriptHash !== hashScript(script)) throw new Error('caption timings do not bind canonical script');
  const sentences = script.sections.flatMap(section => section.sentenceIds.map(id => script.sentences.find(s => s.id === id)!));
  const texts = sentences.map(s => [...captionCharacters(s.text)]);
  if (texts.some(t => !t.length || !t.join('').trim())) throw new Error('caption narration must contain displayable characters');
  const total = texts.reduce((sum, t) => sum + t.length, 0);
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  if (timings.mode === 'provider') {
    if (!timings.words.length) throw new Error('provider timings are empty; use fallback-empty explicitly');
    let offset = 0;
    let actual = '';
    for (const word of timings.words) {
      const normalized = captionCharacters(word.word);
      if (!normalized.length || word.endMs > durationMs) throw new Error('provider word outside voice duration or empty after punctuation');
      starts.set(offset, word.startMs);
      offset += [...normalized].length;
      ends.set(offset, word.endMs);
      actual += normalized;
    }
    if (actual !== texts.map(t => t.join('')).join('')) throw new Error('provider words do not preserve exact canonical narration');
  } else {
    for (let i = 0; i <= total; i++) {
      const time = Math.round(i * durationMs / total);
      starts.set(i, time);
      ends.set(i, time);
    }
  }
  let offset = 0;
  const cues: CaptionCue[] = [];
  sentences.forEach((sentence, sentenceIndex) => {
    const chars = texts[sentenceIndex];
    const preferred = new Set<number>();
    let position = 0;
    for (const char of sentence.text) {
      if (/[\p{P}]/u.test(char)) preferred.add(position);
      else if (char !== '\r' && char !== '\n') position++;
    }
    // Dynamic programming finds a feasible complete partition; punctuation wins among
    // equally small cue counts. Never borrow time across words or sentence boundaries.
    const best = new Map<number, { score: number; end: number }>();
    best.set(chars.length, { score: 0, end: chars.length });
    for (let start = chars.length - 1; start >= 0; start--) {
      const startMs = starts.get(offset + start);
      if (startMs === undefined) continue;
      for (let end = start + 1; end <= Math.min(chars.length, start + 18); end++) {
        const tail = best.get(end);
        const endMs = ends.get(offset + end);
        if (!tail || endMs === undefined || endMs - startMs < 700) continue;
        const score = tail.score + 1000 + (preferred.has(end) ? 0 : 1);
        if (!best.has(start) || score < best.get(start)!.score) best.set(start, { score, end });
      }
    }
    if (!best.has(0)) throw new Error(`caption ${sentence.id} cannot fit 18 characters and 700 ms within voice duration; supply slower/longer audio or corrected word timings`);
    for (let start = 0; start < chars.length;) {
      const end = best.get(start)!.end;
      cues.push(captionCueSchema.parse({ schemaVersion: 1, scriptSentenceId: sentence.id, text: chars.slice(start, end).join(''), startMs: starts.get(offset + start), endMs: ends.get(offset + end) }));
      start = end;
    }
    offset += chars.length;
  });
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].endMs > durationMs || (i && cues[i].startMs < cues[i - 1].endMs)) throw new Error('captions must be non-overlapping and inside voice duration');
  }
  return cues;
}
