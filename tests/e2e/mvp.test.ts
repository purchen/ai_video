import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { readApprovedScript, readApprovedTopic } from '../../src/review/approve';
import { readCommittedVoice } from '../../src/voice/generate-voice';
import { probeMedia, resolveManagedMediaTools } from '../../src/render/media-tools';
import { readWorkflowStatus } from '../../src/workflow/run-stage';
import { qcReportSchema } from '../../src/qc/run-qc';
import { scriptNarrationText } from '../../src/script/narration';
import { buildMvpProject } from '../fixtures/build-mvp-project';

// Catches a missing real pipeline, bypassed approval stop, stale/static COMPLETE,
// wrong narration input/voice identity, missing audio, bad geometry or short render.
it('runs an offline Chinese speech project through both review stops, real render and QC to COMPLETE', async () => {
  await mkdir(resolve('projects/mvp-e2e'), { recursive: true });
  const parent = await mkdtemp(resolve('projects/mvp-e2e/run-'));
  const { store, states } = await buildMvpProject(join(parent, 'mvp-project'));
  console.log(`MVP acceptance output: ${store.root}`);
  expect(states).toEqual(['DISCOVERED', 'TOPIC_REVIEW_REQUIRED', 'TOPIC_REVIEW_REQUIRED', 'TOPIC_APPROVED', 'SCRIPT_REVIEW_REQUIRED', 'SCRIPT_REVIEW_REQUIRED', 'SCRIPT_APPROVED', 'VOICE_READY', 'EDIT_PLAN_READY', 'RENDERED', 'QC_PASSED', 'COMPLETE']);
  expect((await readApprovedTopic(store)).candidateId).toBe('candidate-1');
  const approved = await readApprovedScript(store);
  expect(scriptNarrationText(approved.script)).toBe(await readFile(resolve('tests/fixtures/mvp-project/narration.txt'), 'utf8'));
  const tools = await resolveManagedMediaTools();
  const voice = await readCommittedVoice(store, tools.probe);
  expect(voice.report.voiceId).toBe('Microsoft Huihui Desktop');
  expect(voice.report.providerId).toBe('windows-system-speech-fixture');
  expect(voice.report.voiceKind).toBe('synthetic');
  expect(voice.report.approvedScriptHash).toBe(approved.scriptHash);
  expect(voice.report.sampleRateHz).toBe(48000);
  expect(voice.charge.actual.amount).toBe(0);
  const media = await probeMedia(join(store.root, 'output/final.mp4'));
  expect(media.streams.find(s => s.codec_type === 'video')).toMatchObject({ width: 1080, height: 1920, codec_name: 'h264', avg_frame_rate: '30/1' });
  expect(media.streams.filter(s => s.codec_type === 'audio')).toHaveLength(1);
  expect(media.streams.find(s => s.codec_type === 'audio')?.codec_name).toBe('aac');
  expect(media.format.duration).toBeGreaterThanOrEqual(60);
  expect(media.format.duration).toBeLessThanOrEqual(120);
  expect(Math.abs(media.format.duration * 1000 - voice.report.durationMs)).toBeLessThanOrEqual(100);
  expect(qcReportSchema.parse(JSON.parse(await readFile(join(store.root, 'reports/qc.json'), 'utf8')))).toMatchObject({ status: 'QC_PASSED', errors: [] });
  expect(await readWorkflowStatus(store.root)).toMatchObject({ state: 'COMPLETE', diagnostics: [] });
}, 300_000);
