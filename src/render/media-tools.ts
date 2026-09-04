import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { RenderInternals } from '@remotion/renderer';
import { z } from 'zod';
import { createFfmpegAudioAnalyzer } from '../voice/analyze-audio';
import {
  createFfmpegAudioConverter,
  createFfprobeAudioProbe,
} from '../voice/probe-audio';

export function executeMediaTool(
  executable: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  if (!isAbsolute(executable))
    throw new Error('managed media executable must be absolute');
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      [...args],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(`${error.message}\n${stderr}`))
          : resolve({ stdout, stderr }),
    ),
  );
}

/** Pinned Remotion's own platform resolver; never shell PATH or a machine-specific tracked path. */
export async function resolveManagedMediaTools() {
  const path = (type: 'ffmpeg' | 'ffprobe') =>
    RenderInternals.getExecutablePath({
      type,
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
    });
  const ffmpeg = path('ffmpeg');
  const ffprobe = path('ffprobe');
  await Promise.all([access(ffmpeg), access(ffprobe)]);
  return {
    ffmpeg,
    ffprobe,
    probe: createFfprobeAudioProbe(ffprobe, executeMediaTool, async path => (await createFfmpegAudioAnalyzer(ffmpeg)(path)).integratedLufs),
    converter: createFfmpegAudioConverter(ffmpeg),
  };
}

const mediaSchema = z.object({
  streams: z.array(
    z.object({
      codec_type: z.string(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      avg_frame_rate: z.string().optional(),
      duration: z.union([z.number(), z.string()]).optional(),
      duration_ts: z.union([z.number(), z.string()]).optional(),
      time_base: z.string().optional(),
    }),
  ),
  format: z.object({ duration: z.coerce.number().positive() }),
});
export type MediaMetadata = z.infer<typeof mediaSchema>;

/** Container/audio duration cannot supply missing visual frames. Ambiguous tracks are unsupported. */
export function assertClipCoverage(input: unknown, durationMs: number): void {
  const media = mediaSchema.parse(input);
  const videos = media.streams.filter(
    (stream) => stream.codec_type === 'video',
  );
  if (videos.length !== 1)
    throw new Error('clip video stream selection is missing or ambiguous');
  const video = videos[0];
  const candidates: number[] = [];
  const seconds = Number(video.duration);
  if (Number.isFinite(seconds) && seconds > 0) candidates.push(seconds * 1000);
  const ticks = Number(video.duration_ts);
  const fraction = video.time_base?.match(/^(\d+)\/(\d+)$/);
  if (fraction && Number.isSafeInteger(ticks) && ticks > 0) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    const milliseconds = ((ticks * numerator) / denominator) * 1000;
    if (
      numerator > 0 &&
      denominator > 0 &&
      Number.isFinite(milliseconds) &&
      milliseconds > 0
    )
      candidates.push(milliseconds);
  }
  if (!candidates.length)
    throw new Error(
      'clip video stream duration is unknown; cannot establish coverage',
    );
  if (
    !Number.isFinite(durationMs) ||
    durationMs <= 0 ||
    Math.min(...candidates) + 0.001 < durationMs
  ) {
    throw new Error(
      'clip video stream is shorter than selected scene coverage',
    );
  }
}

export async function probeMedia(path: string): Promise<MediaMetadata> {
  const { ffprobe } = await resolveManagedMediaTools();
  const { stdout } = await executeMediaTool(ffprobe, [
    '-v',
    'error',
    '-show_streams',
    '-show_format',
    '-of',
    'json',
    path,
  ]);
  return mediaSchema.parse(JSON.parse(stdout));
}
export function assertRenderedMedia(input: unknown, durationMs: number): void {
  const media = mediaSchema.parse(input);
  const videos = media.streams.filter((s) => s.codec_type === 'video');
  const audios = media.streams.filter((s) => s.codec_type === 'audio');
  if (
    videos.length !== 1 ||
    audios.length !== 1 ||
    videos[0].codec_name !== 'h264' ||
    audios[0].codec_name !== 'aac' ||
    videos[0].width !== 1080 ||
    videos[0].height !== 1920 ||
    videos[0].avg_frame_rate !== '30/1' ||
    Math.abs(media.format.duration * 1000 - durationMs) > 100
  )
    throw new Error(
      'rendered media failed H264/AAC vertical 30fps duration validation',
    );
}
