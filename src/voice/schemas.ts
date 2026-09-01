import { z } from 'zod';

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const transactionIdSchema = z.string().uuid();

export const costRecordSchema = z.object({
  providerId: z.string().min(1),
  currency: z.literal('CNY'),
  amount: z.number().finite().nonnegative(),
  basis: z.string().min(1),
});

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
  projectId: z.string().min(1),
  approvedScriptHash: sha256Schema,
  transactionId: transactionIdSchema,
  mode: z.enum(['provider', 'fallback-empty']),
  words: z.array(wordTimingSchema),
}).superRefine((timings, context) => {
  if (timings.mode === 'fallback-empty' && timings.words.length !== 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'fallback timing envelope must be empty' });
  }
  for (let index = 1; index < timings.words.length; index += 1) {
    if (timings.words[index].startMs < timings.words[index - 1].endMs) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'word timings must be monotonic and non-overlapping',
        path: ['words', index],
      });
    }
  }
});

export const voiceReportSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('READY'),
  projectId: z.string().min(1),
  transactionId: transactionIdSchema,
  approvedScriptHash: sha256Schema,
  providerId: z.string().min(1),
  model: z.string().min(1),
  voiceId: z.string().min(1),
  voiceKind: z.enum(['synthetic', 'cloned', 'similar-real-person']),
  authorization: z.enum(['synthetic', 'user-authorized']),
  authorizationReference: z.string().min(1),
  authorizationHash: sha256Schema,
  durationMs: z.number().int().positive(),
  sampleRateHz: z.number().int().positive(),
  channels: z.number().int().positive(),
  formatName: z.string().min(1),
  codecName: z.string().min(1),
  integratedLufs: z.number().finite().nullable(),
  costCny: z.number().finite().nonnegative(),
  generatedAt: z.string().datetime(),
}).superRefine((report, context) => {
  const agrees = report.voiceKind === 'synthetic'
    ? report.authorization === 'synthetic'
    : report.authorization === 'user-authorized';
  if (!agrees) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'voice kind and authorization must agree' });
  }
});

export const voiceAuthorizationSchema = z.object({
  schemaVersion: z.literal(1),
  voiceId: z.string().min(1),
  kind: z.enum(['cloned', 'similar-real-person']),
  authorizedBy: z.string().min(1),
  authorizedAt: z.string().datetime(),
  consentReference: z.string().min(1),
});

export const voiceChargeSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: transactionIdSchema,
  projectId: z.string().min(1),
  approvedScriptHash: sha256Schema,
  providerId: z.string().min(1),
  estimate: costRecordSchema,
  actual: costRecordSchema,
  status: z.enum(['SETTLED_WITHIN_AUTHORIZATION', 'SETTLED_OVER_AUTHORIZATION']),
  settledAt: z.string().datetime(),
}).superRefine((charge, context) => {
  if (charge.estimate.providerId !== charge.providerId || charge.actual.providerId !== charge.providerId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'charge providers must match the transaction provider',
    });
  }
});

export const voiceCommitMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  transactionId: transactionIdSchema,
  projectId: z.string().min(1),
  approvedScriptHash: sha256Schema,
  masterHash: sha256Schema,
  timingsHash: sha256Schema,
  reportHash: sha256Schema,
  chargeHash: sha256Schema,
  authorizationReference: z.string().min(1),
  authorizationHash: sha256Schema,
  committedAt: z.string().datetime(),
});

export type VoiceReport = z.infer<typeof voiceReportSchema>;
export type WordTimings = z.infer<typeof wordTimingsSchema>;
export type VoiceAuthorization = z.infer<typeof voiceAuthorizationSchema>;
export type VoiceCharge = z.infer<typeof voiceChargeSchema>;
export type VoiceCommitMarker = z.infer<typeof voiceCommitMarkerSchema>;
