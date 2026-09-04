import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectManifestSchema } from '../../src/domain/schemas';
import { approveTopic, approveScript } from '../../src/review/approve';
import { buildResearchBrief } from '../../src/research/build-brief';
import { buildScript } from '../../src/script/build-script';
import { ProjectStore } from '../../src/store/project-store';
import { approvedFixture, now } from '../voice/fixtures';
import { createManualVoicePackage, importManualVoice } from '../../src/providers/tts/manual';
import { writeEditPlan, assetManifestSchema } from '../../src/edit/build-edit-plan';
import type { AudioProbe } from '../../src/voice/probe-audio';

export const probe: AudioProbe = { probe: async () => ({ durationMs: 60000, sampleRateHz: 48000, channels: 1, formatName: 'wav', codecName: 'pcm_s16le', integratedLufs: null }) };
export const media = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, avg_frame_rate: '30/1' }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: 60 } };
// Only fake-media unit tests use this boundary double; real QC/e2e never do.
export const analyzeAudio = async (path: string) => ({ integratedLufs: path.endsWith('music.wav') ? -40 : -20, truePeakDbtp: -3, silenceSegments: [] });
export const candidate = { title: '夜校报名延长', normalizedTopic: 'night-school', questionHook: '报名延长意味着什么？', sourceUrls: ['https://example.com/official'], sourcePublishers: ['官方'], risks: [], eligibleForRecommendation: true, score: { relevance: 5, tension: 4, evidenceAvailability: 5, independentJudgment: 5, laneFit: 5, visualDifficulty: 2, risk: 1, total: 4.5 } };
export const sources = [{ schemaVersion: 1 as const, id: 'official-1', url: 'https://example.com/official', title: '报名公告', publisher: '官方', summary: '官方确认报名延长。', sourceType: 'official-data' as const, evidenceWeight: 'high' as const, capturedAt: now, claim: { key: 'extension', value: 'affirmed' as const, text: '官方确认报名延长。' } }];
export const lenses = [{ id: 'user-experience', label: '用户体验', text: '延长时段可能方便安排', basis: 'everyday-common-sense' as const, sourceIds: [], applicability: '仅作解释，不证明实际效果或所有用户受益' }];
export async function prepared(root?: string, directoryName = 'topic-001') {
  const parent = root ?? await mkdtemp(join(tmpdir(), 'workflow-'));
  const store = await ProjectStore.create(parent, directoryName);
  const brief = buildResearchBrief(candidate, sources, { lenses });
  const script = approvedFixture().script;
  script.sentences.forEach(s => { s.text = s.type === 'fact' ? '官方确认报名延长。' : '我们还需要关注实际变化。'; });
  script.estimatedDurationMs = 60000;
  const manifest = projectManifestSchema.parse({ schemaVersion: 1, id: 'topic-001', topic: candidate.title, workflowState: 'TOPIC_REVIEW_REQUIRED', createdAt: now, updatedAt: now, sources });
  await store.writeJson('project.json', projectManifestSchema, manifest);
  await writeFile(join(store.root, 'sources.json'), JSON.stringify({ schemaVersion: 1, sources, lenses }));
  await writeFile(join(store.root, 'topic-candidates.json'), JSON.stringify({ schemaVersion: 1, candidates: [candidate, ...Array.from({ length: 4 }, (_, i) => ({ ...candidate, title: `合成测试候选 ${i + 2}`, normalizedTopic: `synthetic-${i + 2}` }))] }));
  const project = { store, manifest, brief, candidates: [{ id: 'candidate-1', candidate }] };
  await approveTopic(project, 'candidate-1', 'fixture-editor');
  await buildScript(project, brief, { id: 'local-fixture', generate: async () => script });
  await approveScript({ ...project, draft: script }, 'fixture-editor');
  return { store, parent, brief, script };
}
export async function production() {
  const result = await prepared();
  const approved = await import('../../src/review/approve').then(m => m.readApprovedScript(result.store));
  await createManualVoicePackage({ store: result.store, requestedScriptHash: approved.scriptHash });
  await importManualVoice({ store: result.store, requestedScriptHash: approved.scriptHash, attemptId: '00000000-0000-4000-8000-000000000009', audioPath: 'fixture', authorization: { schemaVersion: 1, sourceKind: 'jianying-synthetic', authorization: 'synthetic', voiceKind: 'synthetic', voiceId: 'fixture', authorizedBy: 'editor', authorizedAt: now, consentReference: 'fixture-license', syntheticIdentifier: 'fixture-synthetic' }, probe, converter: { convertToWav48k: async (_, output) => { await writeFile(output, 'offline test double audio'); } } });
  const assets = { schemaVersion: 1 as const, projectId: 'topic-001', assets: [] };
  await result.store.writeJson('asset-manifest.json', assetManifestSchema, assets);
  await writeEditPlan(result.store, probe, assets);
  return result;
}
export async function selectedProduction() {
  const f = await production();
  const assets = assetManifestSchema.parse({ schemaVersion: 1, projectId: 'topic-001', assets: [
    { schemaVersion: 1, id: 'clip', kind: 'clip', path: 'clip.mp4', sentenceIds: ['sentence-question-hook'], permission: 'permitted', permissionRecord: { schemaVersion: 1, assetId: 'clip', reference: 'clip-license.txt' } },
    { schemaVersion: 1, id: 'abstract', kind: 'generated-abstract', path: 'abstract.png', sentenceIds: ['sentence-mechanism'], permission: 'permitted', permissionRecord: { schemaVersion: 1, assetId: 'abstract', reference: 'abstract-license.txt' }, generationRecord: { schemaVersion: 1, assetId: 'abstract', provider: 'offline-fixture', reference: 'generation.json' } },
    { schemaVersion: 1, id: 'music', kind: 'music', path: 'music.wav', sentenceIds: [], permission: 'permitted', permissionRecord: { schemaVersion: 1, assetId: 'music', reference: 'music-license.txt' } },
  ] });
  for (const name of ['clip.mp4', 'clip-license.txt', 'abstract.png', 'abstract-license.txt', 'generation.json', 'music.wav', 'music-license.txt']) await writeFile(join(f.store.root, name), `offline resource double: ${name}`);
  await f.store.writeJson('asset-manifest.json', assetManifestSchema, assets);
  await writeEditPlan(f.store, probe, assets, { tone: 'neutral', informationDensity: 'normal' });
  return f;
}
