import { relative } from 'node:path';
import { z } from 'zod';
import { projectManifestSchema, scriptSectionTypeSchema, sourceRecordSchema, validateEvidenceBindings, type SourceRecord } from '../domain/schemas';
import { approvedScriptSchema, readApprovedScript, type ApprovedScript } from '../review/approve';
import { hashCanonicalJson } from '../script/hash-script';
import type { ProjectStore } from '../store/project-store';
import { readCommittedVoice } from '../voice/generate-voice';
import type { AudioProbe } from '../voice/probe-audio';
import { sha256Schema, voiceReportSchema, type VoiceReport, type WordTimings } from '../voice/schemas';
import { buildCaptions, captionCueSchema } from './build-captions';

export const projectRelativePathSchema = z.string().min(1).refine(path =>
  !/[\\:%\x00-\x1f<>"|?*]/.test(path) && !path.startsWith('/')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'path must be traversal-safe and project-relative');
const permissionRecordSchema = z.object({ schemaVersion: z.literal(1), assetId: z.string().min(1), reference: projectRelativePathSchema });
const generationRecordSchema = z.object({ schemaVersion: z.literal(1), assetId: z.string().min(1), provider: z.string().min(1), reference: projectRelativePathSchema });
export const assetRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().min(1), kind: z.enum(['clip', 'generated-abstract', 'music']),
  path: projectRelativePathSchema, sentenceIds: z.array(z.string().min(1)), permission: z.enum(['unknown', 'permitted']),
  permissionRecord: permissionRecordSchema.optional(), generationRecord: generationRecordSchema.optional(),
}).superRefine((asset, ctx) => {
  if ((asset.permission === 'permitted' && !asset.permissionRecord)
    || (asset.permissionRecord && asset.permissionRecord.assetId !== asset.id)
    || (asset.generationRecord && asset.generationRecord.assetId !== asset.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'permission/generation record must bind selected asset' });
});
export const assetManifestSchema = z.object({ schemaVersion: z.literal(1), projectId: z.string().min(1), assets: z.array(assetRecordSchema) }).superRefine((manifest, ctx) => {
  if (new Set(manifest.assets.map(a => a.id)).size !== manifest.assets.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate asset id' });
});
export type AssetRecord = z.infer<typeof assetRecordSchema>;
export type AssetManifest = z.infer<typeof assetManifestSchema>;
const provenanceSchema = z.object({ assetId: z.string().min(1), path: projectRelativePathSchema, permissionRecord: permissionRecordSchema, generationRecord: generationRecordSchema.optional() }).superRefine((a, ctx) => {
  if (a.assetId !== a.permissionRecord.assetId || (a.generationRecord && a.assetId !== a.generationRecord.assetId)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'asset provenance binding mismatch' });
});
const visualSchema = z.union([
  z.object({ kind: z.literal('kinetic-text'), text: z.string().min(1), publicQuestionLabel: z.literal('公众疑问（非事实证据）').optional() }),
  z.object({ kind: z.literal('source-card'), sources: z.array(sourceRecordSchema.refine(s => s.sourceType !== 'comment-sample', 'comments are not factual sources')).min(1) }),
  z.object({ kind: z.literal('authorized-clip'), asset: provenanceSchema }),
  z.object({ kind: z.literal('ai-abstract'), asset: provenanceSchema.refine(a => !!a.generationRecord, 'abstract asset requires generation record') }),
]);
export const editPlanSchema = z.object({
  schemaVersion: z.literal(1), projectId: z.string().min(1), approvedScriptHash: sha256Schema, voiceReportHash: sha256Schema,
  voice: z.object({ masterPath: projectRelativePathSchema, durationMs: z.number().int().positive() }),
  scenes: z.array(z.object({ id: z.string().min(1), section: scriptSectionTypeSchema, scriptSentenceIds: z.array(z.string().min(1)).min(1), startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), visual: visualSchema })).min(1),
  captions: z.array(captionCueSchema).min(1),
  music: z.union([z.object({ mode: z.literal('none') }), z.object({ mode: z.literal('ambient'), relativeGainDb: z.number().finite().max(-16), asset: provenanceSchema })]),
  warnings: z.array(z.string()),
}).superRefine((plan, ctx) => {
  for (const entries of [plan.scenes, plan.captions]) entries.forEach((entry, i) => {
    if (entry.endMs <= entry.startMs || entry.endMs > plan.voice.durationMs || (i > 0 && entry.startMs < entries[i - 1].endMs)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'edit timing outside duration or overlapping' });
  });
  if (plan.voice.masterPath === 'voice/master.wav' || !/^voice\/transactions\/[^/]+\/master\.wav$/.test(plan.voice.masterPath)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'voice must use immutable transaction master path' });
  const ids = plan.scenes.flatMap(s => s.scriptSentenceIds);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate scene sentence' });
  if (new Set(plan.scenes.map(s => s.id)).size !== plan.scenes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate scene id' });
  for (const id of ids) if (!plan.captions.some(c => c.scriptSentenceId === id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'scene is missing captions' });
  for (const cue of plan.captions) {
    const scene = plan.scenes.find(s => s.scriptSentenceIds.includes(cue.scriptSentenceId));
    if (!scene || cue.startMs < scene.startMs || cue.endMs > scene.endMs) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'caption must bind containing scene' });
  }
});
export type EditPlan = z.infer<typeof editPlanSchema>;
export interface BuildEditPlanInput {
  approvedScript: ApprovedScript; voiceReport: VoiceReport; timings: WordTimings; sources: SourceRecord[]; assets: AssetManifest;
  voiceMasterPath?: string;
  policy?: { tone: 'serious' | 'neutral'; informationDensity: 'dense' | 'normal' };
}

export function buildEditPlan(input: BuildEditPlanInput): EditPlan {
  const approved = approvedScriptSchema.parse(input.approvedScript);
  const voice = voiceReportSchema.parse(input.voiceReport);
  const assets = assetManifestSchema.parse(input.assets);
  const sources = z.array(sourceRecordSchema).parse(input.sources);
  if (voice.approvedScriptHash !== approved.scriptHash || voice.projectId !== approved.script.projectId || assets.projectId !== approved.script.projectId) throw new Error('edit inputs must bind approved script hash and project');
  if (input.timings.transactionId !== voice.transactionId) throw new Error('timings must bind selected voice transaction');
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw new Error('duplicate source id');
  validateEvidenceBindings(sources, approved.script.sentences);
  const sentenceIds = new Set(approved.script.sentences.map(s => s.id));
  for (const asset of assets.assets) if (asset.sentenceIds.some(id => !sentenceIds.has(id))) throw new Error(`asset ${asset.id} references unknown sentence`);
  const captions = buildCaptions(approved.script, input.timings, { durationMs: voice.durationMs });
  const warnings = assets.assets.filter(a => a.permission === 'unknown').map(a => `${a.id} downgraded because permission is unknown`);
  const sorted = [...assets.assets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const provenance = (a: AssetRecord) => ({ assetId: a.id, path: a.path, permissionRecord: a.permissionRecord!, ...(a.generationRecord ? { generationRecord: a.generationRecord } : {}) });
  const scenes = approved.script.sections.flatMap(section => section.sentenceIds.map(id => {
    const sentence = approved.script.sentences.find(s => s.id === id)!;
    const cues = captions.filter(c => c.scriptSentenceId === id);
    const hasComment = sentence.sourceIds.some(sourceId => sources.some(s => s.id === sourceId && s.sourceType === 'comment-sample'));
    let visual: z.infer<typeof visualSchema> = { kind: 'kinetic-text', text: sentence.text, ...(hasComment ? { publicQuestionLabel: '公众疑问（非事实证据）' as const } : {}) };
    const needsSource = sentence.type === 'fact' || section.type === 'strong-evidence' || section.type === 'counter-evidence';
    const boundSources = sentence.sourceIds.map(sourceId => sources.find(s => s.id === sourceId)).filter((s): s is SourceRecord => !!s && s.sourceType !== 'comment-sample');
    if (needsSource) {
      if (boundSources.length) visual = { kind: 'source-card', sources: boundSources };
      else warnings.push(`${id} uses kinetic text because no bound factual source is available`);
    } else {
      const clip = sorted.find(a => a.kind === 'clip' && a.permission === 'permitted' && a.sentenceIds.includes(id));
      const abstract = sorted.find(a => a.kind === 'generated-abstract' && a.permission === 'permitted' && a.generationRecord && a.sentenceIds.includes(id));
      if (clip) visual = { kind: 'authorized-clip', asset: provenance(clip) };
      else if (sentence.type === 'transition' && abstract) visual = { kind: 'ai-abstract', asset: provenance(abstract) };
    }
    return { id: `scene-${id}`, section: section.type, scriptSentenceIds: [id], startMs: cues[0].startMs, endMs: cues[cues.length - 1].endMs, visual };
  }));
  const policy = z.object({ tone: z.enum(['serious', 'neutral']), informationDensity: z.enum(['dense', 'normal']) }).parse(input.policy ?? { tone: 'serious', informationDensity: 'dense' });
  const musicAsset = sorted.find(a => a.kind === 'music' && a.permission === 'permitted');
  const music = policy.tone === 'serious' && policy.informationDensity === 'dense' || !musicAsset
    ? { mode: 'none' as const } : { mode: 'ambient' as const, relativeGainDb: -16, asset: provenance(musicAsset) };
  const expectedMasterPath = `voice/transactions/${voice.transactionId}/master.wav`;
  if (input.voiceMasterPath && input.voiceMasterPath !== expectedMasterPath) throw new Error('voice master path does not match immutable report transaction');
  return editPlanSchema.parse({ schemaVersion: 1, projectId: approved.script.projectId, approvedScriptHash: approved.scriptHash, voiceReportHash: hashCanonicalJson(voice), voice: { masterPath: expectedMasterPath, durationMs: voice.durationMs }, scenes, captions, music, warnings });
}

/** Formal readers are mandatory here; callers cannot substitute draft or flat voice artifacts. */
export async function writeEditPlan(store: ProjectStore, probe: AudioProbe, assets: AssetManifest, policy?: BuildEditPlanInput['policy']): Promise<EditPlan> {
  const approvedScript = await readApprovedScript(store);
  const voice = await readCommittedVoice(store, probe);
  const manifest = await store.readJson('project.json', projectManifestSchema);
  const plan = buildEditPlan({ approvedScript, voiceReport: voice.report, timings: voice.timings, voiceMasterPath: relative(store.root, voice.masterPath).replace(/\\/g, '/'), sources: manifest.sources, assets, policy });
  await store.writeJson('edit-plan.json', editPlanSchema, plan);
  return plan;
}
