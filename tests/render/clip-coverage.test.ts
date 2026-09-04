import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  assertClipCoverage as assertCoverage,
  executeMediaTool,
  probeMedia,
  resolveManagedMediaTools,
} from '../../src/render/media-tools';

it('rejects a real one-second video with six-second audio for a five-second scene', async () => {
  const root = resolve('projects/clip-coverage');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'run-'));
  const path = join(directory, 'short-video-long-audio.mp4');
  const image = join(directory, 'original-procedural.png');
  // Original 64x64 procedural image, encoded from our renderer test fixture.
  await writeFile(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAA1klEQVR4nO3PAUYeAABA4f8kERERESNGRMSIiBERPREjIiJGRERERERPRMSIiIgYERER0WU6Qhd43w2+wZAMy4iMypiMy4RMyg+Zkp8yLTMyK3PyS+ZlQRbltyzJsqzIqqzJuvyRDdmULdmWHfkru7In+3Igh3Ikx3Iip3Im53Ihl3Il1/JPbuRW7uReHuRR/suTPMuLvMqbvMuHfMqgQIECBQoUKFCgQIECBQoUKFCgQIECBQoUKFCgQIECBQoUKFCgQIECBQoUKFCgQIECBQoUKPBd4AuzXAlpad6zXgAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const { ffmpeg } = await resolveManagedMediaTools();
  const shortVideo = join(directory, 'video-only.mp4');
  await executeMediaTool(ffmpeg, [
    '-y',
    '-loop',
    '1',
    '-i',
    image,
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    shortVideo,
  ]);
  await executeMediaTool(ffmpeg, [
    '-y',
    '-i',
    shortVideo,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=6',
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    path,
  ]);
  const media = await probeMedia(path);
  expect(media.format.duration).toBeGreaterThanOrEqual(6);
  expect(media.streams[0].duration).toBe('1.000000');
  expect(() => assertCoverage(media, 5000)).toThrow(/video.*short|coverage/);
  expect(() => assertCoverage(media, 1000)).not.toThrow();
}, 30000);

it('uses stream duration or duration_ts/time_base, never a longer container or later video stream', async () => {
  const media = (stream: object, later: object[] = []) => ({
    streams: [{ codec_type: 'video', ...stream }, ...later],
    format: { duration: 60 },
  });
  expect(() => assertCoverage(media({ duration: '5' }), 5000)).not.toThrow();
  expect(() =>
    assertCoverage(
      media({ duration: 'N/A', duration_ts: 450000, time_base: '1/90000' }),
      5000,
    ),
  ).not.toThrow();
  for (const stream of [
    {},
    { duration: 'N/A' },
    { duration: '1' },
    { duration: '-1' },
    { duration_ts: 450000, time_base: '1/0' },
  ]) {
    expect(() => assertCoverage(media(stream), 5000)).toThrow();
  }
  expect(() =>
    assertCoverage(
      media({ duration: '1' }, [{ codec_type: 'video', duration: '60' }]),
      5000,
    ),
  ).toThrow(/ambiguous/);
});
