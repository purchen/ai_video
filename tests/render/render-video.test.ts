import { expect, it } from 'vitest';
import { buildEditPlan } from '../../src/edit/build-edit-plan';
import { fixture } from '../edit/fixtures';
import { validateRenderInputs as validate } from '../../src/render/validate-inputs';
import { assertRenderedMedia as assertMedia } from '../../src/render/media-tools';

it('rejects stale production hashes, changed captions/text/source metadata and missing public-question labels', async () => {
  const f = fixture();
  const plan = buildEditPlan(f);
  expect(() => validate(plan, f)).not.toThrow();
  expect(() =>
    validate({ ...plan, approvedScriptHash: 'a'.repeat(64) }, f),
  ).toThrow(/hash/);
  expect(() =>
    validate({ ...plan, voiceReportHash: 'a'.repeat(64) }, f),
  ).toThrow(/hash/);
  expect(() =>
    validate({ ...plan, voice: { ...plan.voice, durationMs: 22000 } }, f),
  ).toThrow();
  for (const mutate of [
    (p: typeof plan) => {
      p.captions[0].text = '伪造字幕';
    },
    (p: typeof plan) => {
      p.scenes[0].visual = { kind: 'kinetic-text', text: '伪造口播' };
    },
    (p: typeof plan) => {
      if (p.scenes[1].visual.kind === 'source-card')
        p.scenes[1].visual.sources[0].publisher = '伪造来源';
    },
    (p: typeof plan) => {
      p.scenes[0].publicQuestionLabel = '公众疑问（非事实证据）';
    },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    expect(() => validate(changed, f)).toThrow();
  }
});

it('rejects final output without H264/AAC, required dimensions, fps or expected duration', async () => {
  const media = {
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1080,
        height: 1920,
        avg_frame_rate: '30/1',
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: { duration: '6' },
  };
  expect(() => assertMedia(media, 6000)).not.toThrow();
  for (const changed of [
    { ...media, streams: media.streams.slice(0, 1) },
    {
      ...media,
      streams: [{ ...media.streams[0], width: 1920 }, media.streams[1]],
    },
    { ...media, format: { duration: '4' } },
    {
      ...media,
      streams: [
        { ...media.streams[0], avg_frame_rate: '25/1' },
        media.streams[1],
      ],
    },
    {
      ...media,
      streams: [
        media.streams[0],
        { codec_type: 'audio', codec_name: 'pcm_s16le' },
      ],
    },
  ])
    expect(() => assertMedia(changed, 6000)).toThrow();
});
