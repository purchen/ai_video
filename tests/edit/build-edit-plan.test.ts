import { describe, expect, it } from 'vitest';
import { buildEditPlan, assetManifestSchema, editPlanSchema } from '../../src/edit/build-edit-plan';
import { fixture } from './fixtures';
import { hashScript } from '../../src/script/hash-script';

const clip = { schemaVersion: 1 as const, id: 'clip-1', kind: 'clip' as const, path: 'assets/clip.mp4', sentenceIds: ['sentence-mechanism'], permission: 'unknown' as const };
const permitted = { ...clip, permission: 'permitted' as const, permissionRecord: { schemaVersion: 1 as const, assetId: 'clip-1', reference: 'licenses/clip.txt' } };
describe('edit decisions', () => {
  it('downgrades a proposed clip with unknown permission', () => {
    const f = fixture();
    const plan = buildEditPlan({ ...f, assets: { ...f.assets, assets: [clip] } });
    expect(plan.scenes[3].visual.kind).toBe('kinetic-text');
    expect(plan.warnings).toContain('clip-1 downgraded because permission is unknown');
  });
  it('uses factual source cards before permitted clips and no music for serious dense scripts', () => {
    const f = fixture();
    const plan = buildEditPlan({ ...f, assets: { ...f.assets, assets: [{ ...permitted, sentenceIds: ['sentence-strong-evidence'] }] } });
    expect(plan.scenes[2].visual).toMatchObject({ kind: 'source-card', sources: [{ id: 'official-1', url: 'https://example.com/notice' }] });
    expect(plan.music.mode).toBe('none');
    expect(plan.approvedScriptHash).toBe(f.approvedScript.scriptHash);
    expect(plan.voiceReportHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildEditPlan(f)).toEqual(buildEditPlan(f));
    expect(editPlanSchema.parse(plan)).toEqual(plan);
  });
  it('binds selected clips and abstract generation provenance', () => {
    const f = fixture();
    const generated = { ...permitted, id: 'ai-1', kind: 'generated-abstract' as const, sentenceIds: ['sentence-judgment'], permissionRecord: { schemaVersion: 1 as const, assetId: 'ai-1', reference: 'licenses/ai.txt' }, generationRecord: { schemaVersion: 1 as const, assetId: 'ai-1', provider: 'offline-provider', reference: 'generation/ai.json' } };
    const plan = buildEditPlan({ ...f, assets: { ...f.assets, assets: [permitted, generated] } });
    expect(plan.scenes[3].visual).toMatchObject({ kind: 'authorized-clip', asset: { assetId: 'clip-1', permissionRecord: { assetId: 'clip-1' } } });
    expect(plan.scenes[5].visual).toMatchObject({ kind: 'ai-abstract', asset: { generationRecord: { assetId: 'ai-1' } } });
  });
  it('requires licensed ambient music and limits relative gain', () => {
    const f = fixture();
    const music = { ...permitted, id: 'music-1', kind: 'music' as const, sentenceIds: [], permissionRecord: { schemaVersion: 1 as const, assetId: 'music-1', reference: 'licenses/music.txt' } };
    const plan = buildEditPlan({ ...f, policy: { tone: 'neutral', informationDensity: 'normal' }, assets: { ...f.assets, assets: [music] } });
    expect(plan.music).toMatchObject({ mode: 'ambient', relativeGainDb: -16, asset: { assetId: 'music-1' } });
    expect(buildEditPlan({ ...f, policy: { tone: 'neutral', informationDensity: 'normal' } }).music.mode).toBe('none');
  });
  it('rejects manual results, stale voice, wrong project, comments as facts and missing sources', () => {
    const f = fixture();
    for (const voiceReport of [{ ...f.voiceReport, status: 'MANUAL_AUDIO_REQUIRED' }, { ...f.voiceReport, approvedScriptHash: 'b'.repeat(64) }, { ...f.voiceReport, projectId: 'other' }]) expect(() => buildEditPlan({ ...f, voiceReport } as never)).toThrow();
    expect(() => buildEditPlan({ ...f, sources: [] })).toThrow(/source/i);
    expect(() => buildEditPlan({ ...f, sources: [{ ...f.sources[0], sourceType: 'comment-sample' }] })).toThrow(/comment/i);
  });
  it('rejects unsafe paths, duplicate assets, and mismatched permission/generation bindings', () => {
    const f = fixture();
    for (const path of ['../x', '/x', 'C:/x', 'assets/../x', 'assets\\x', 'assets/x:ads', 'assets/%2e%2e/x']) expect(() => assetManifestSchema.parse({ ...f.assets, assets: [{ ...clip, path }] })).toThrow();
    expect(() => buildEditPlan({ ...f, assets: { ...f.assets, assets: [clip, clip] } })).toThrow(/duplicate/i);
    expect(() => buildEditPlan({ ...f, assets: { ...f.assets, assets: [{ ...permitted, permissionRecord: { ...permitted.permissionRecord, assetId: 'other' } }] } })).toThrow();
  });
  it('rejects artifacts with orphan scenes or duplicate scene IDs before persistence', () => {
    const plan = buildEditPlan(fixture());
    expect(() => editPlanSchema.parse({ ...plan, captions: plan.captions.slice(1) })).toThrow();
    expect(() => editPlanSchema.parse({ ...plan, scenes: plan.scenes.map(s => ({ ...s, id: 'same' })) })).toThrow();
  });
  it('labels comment-bound hook text as public questions, never source evidence', () => {
    const f = fixture();
    f.approvedScript.script.sentences[0].sourceIds = ['comment-1'];
    f.approvedScript.scriptHash = hashScript(f.approvedScript.script);
    f.voiceReport.approvedScriptHash = f.approvedScript.scriptHash;
    f.timings.approvedScriptHash = f.approvedScript.scriptHash;
    const plan = buildEditPlan({ ...f, sources: [...f.sources, { ...f.sources[0], id: 'comment-1', sourceType: 'comment-sample', evidenceWeight: 'low' }] });
    expect(plan.scenes[0].visual).toMatchObject({ kind: 'kinetic-text', publicQuestionLabel: '公众疑问（非事实证据）', text: '你怎么看这件事情？' });
  });
});
