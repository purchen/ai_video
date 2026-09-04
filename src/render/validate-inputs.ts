import {
  buildEditPlan,
  editPlanSchema,
  type AssetRecord,
  type BuildEditPlanInput,
} from '../edit/build-edit-plan';
import { hashCanonicalJson } from '../script/hash-script';

/** Re-derive content from locked narration and factual sources, never trust editable visual text. */
export function validateRenderInputs(
  input: unknown,
  context: Omit<BuildEditPlanInput, 'assets'>,
) {
  const plan = editPlanSchema.parse(input);
  if (
    plan.approvedScriptHash !== context.approvedScript.scriptHash ||
    plan.voiceReportHash !== hashCanonicalJson(context.voiceReport)
  )
    throw new Error('render production hash mismatch');
  const assets: AssetRecord[] = [];
  for (const scene of plan.scenes) {
    if (
      scene.visual.kind !== 'authorized-clip' &&
      scene.visual.kind !== 'ai-abstract'
    )
      continue;
    const { asset } = scene.visual;
    const previous = assets.find((a) => a.id === asset.assetId);
    if (previous) {
      if (
        previous.path !== asset.path ||
        hashCanonicalJson(previous.permissionRecord) !==
          hashCanonicalJson(asset.permissionRecord) ||
        hashCanonicalJson(previous.generationRecord ?? null) !==
          hashCanonicalJson(asset.generationRecord ?? null)
      )
        throw new Error('conflicting asset provenance');
      previous.sentenceIds.push(...scene.scriptSentenceIds);
    } else
      assets.push({
        schemaVersion: 1,
        id: asset.assetId,
        kind:
          scene.visual.kind === 'authorized-clip'
            ? 'clip'
            : 'generated-abstract',
        path: asset.path,
        sentenceIds: [...scene.scriptSentenceIds],
        permission: 'permitted',
        permissionRecord: asset.permissionRecord,
        generationRecord: asset.generationRecord,
      });
  }
  if (plan.music.mode === 'ambient') {
    const { asset } = plan.music;
    assets.push({
      schemaVersion: 1,
      id: asset.assetId,
      kind: 'music',
      path: asset.path,
      sentenceIds: [],
      permission: 'permitted',
      permissionRecord: asset.permissionRecord,
      generationRecord: asset.generationRecord,
    });
  }
  const expected = buildEditPlan({
    ...context,
    assets: { schemaVersion: 1, projectId: plan.projectId, assets },
    policy:
      plan.music.mode === 'none'
        ? { tone: 'serious', informationDensity: 'dense' }
        : { tone: 'neutral', informationDensity: 'normal' },
  });
  for (const key of ['projectId', 'voice', 'scenes', 'captions'] as const) {
    if (hashCanonicalJson(plan[key]) !== hashCanonicalJson(expected[key]))
      throw new Error(
        `render ${key} differs from approved content or voice metadata`,
      );
  }
  return plan;
}
