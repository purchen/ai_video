import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const wordTimingSchema = z.object({
  word: z.string().min(1),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
}).superRefine((timing, context) => {
  if (timing.endMs < timing.startMs) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'word timing end must not precede start' });
  }
});

export const wordTimingsSchema = z.object({
  schemaVersion: z.literal(1),
  mode: z.enum(['provider', 'fallback-empty']),
  words: z.array(wordTimingSchema),
}).superRefine((timings, context) => {
  if (timings.mode === 'fallback-empty' && timings.words.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'fallback timing envelope must be empty' });
  }
});

export const voiceReportSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('READY'),
  approvedScriptHash: sha256Schema,
  providerId: z.string().min(1),
  model: z.string().min(1),
  voiceId: z.string().min(1),
  authorization: z.enum(['synthetic', 'user-authorized']),
  durationMs: z.number().int().positive(),
  sampleRateHz: z.number().int().positive(),
  channels: z.number().int().positive(),
  integratedLufs: z.number().finite().nullable(),
  costCny: z.number().finite().nonnegative(),
  generatedAt: z.string().datetime(),
});

export const voiceAuthorizationSchema = z.object({
  schemaVersion: z.literal(1),
  voiceId: z.string().min(1),
  kind: z.enum(['cloned', 'similar-real-person']),
  authorizedBy: z.string().min(1),
  authorizedAt: z.string().datetime(),
  consentReference: z.string().min(1),
});

export type VoiceReport = z.infer<typeof voiceReportSchema>;
export type WordTimings = z.infer<typeof wordTimingsSchema>;
export type VoiceAuthorization = z.infer<typeof voiceAuthorizationSchema>;
