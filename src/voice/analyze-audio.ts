import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const audioMeasurementsSchema = z.object({
  integratedLufs: z.number().finite().nullable(),
  truePeakDbtp: z.number().finite().nullable(),
  silenceSegments: z.array(z.object({ startMs: z.number().nonnegative(), endMs: z.number().nonnegative() })),
});
export type AudioMeasurements = z.infer<typeof audioMeasurementsSchema>;
export interface AudioAnalysisOptions { gainDb?: number; durationMs?: number; loop?: boolean }
export type AudioAnalyzer = (path: string, options?: AudioAnalysisOptions) => Promise<AudioMeasurements>;

/** Measures the input, never the normalized output. Uses the pinned managed binary. */
export function createFfmpegAudioAnalyzer(executable: string): AudioAnalyzer {
  if (!isAbsolute(executable)) throw new Error('audio analyzer requires an absolute managed FFmpeg path');
  return async (path, options = {}) => {
    const gain = z.number().finite().parse(options.gainDb ?? 0);
    const duration = options.durationMs === undefined ? undefined : z.number().finite().positive().parse(options.durationMs);
    if (options.loop && !duration) throw new Error('looped audio measurement requires a bounded duration');
    const filters = [
      ...(duration ? [`atrim=duration=${duration / 1000}`] : []),
      `volume=${gain}dB`, 'silencedetect=n=-50dB:d=2', 'loudnorm=print_format=json',
    ];
    const args = ['-hide_banner', '-nostdin', '-nostats', ...(options.loop ? ['-stream_loop', '-1'] : []), '-i', path,
      '-map', '0:a:0', '-vn', '-af', filters.join(','), '-f', 'null', '-'];
    const stderr = await new Promise<string>((resolve, reject) => {
      execFile(executable, args, { windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`audio measurement failed: ${error.message}\n${stderr}`)); else resolve(stderr);
      });
    });
    const json = stderr.match(/\{\s*"input_i"[\s\S]*?\}/)?.[0];
    if (!json) throw new Error('required loudness/true-peak measurements are unavailable');
    const raw = z.object({ input_i: z.string(), input_tp: z.string() }).parse(JSON.parse(json));
    const level = (value: string) => {
      if (value === '-inf') return null; // Silence is unmeasurable, never a passing level.
      const number = Number(value); if (!Number.isFinite(number)) throw new Error('invalid measured audio level');
      return number;
    };
    const silenceSegments: AudioMeasurements['silenceSegments'] = [];
    let start: number | undefined;
    for (const entry of stderr.matchAll(/silence_(start|end):\s*([\d.e+-]+)/g)) {
      const time = Math.round(Number(entry[2]) * 1000);
      if (entry[1] === 'start') start = time;
      else if (start !== undefined) { silenceSegments.push({ startMs: start, endMs: time }); start = undefined; }
    }
    if (start !== undefined) throw new Error('silence measurement is incomplete');
    return audioMeasurementsSchema.parse({ integratedLufs: level(raw.input_i), truePeakDbtp: level(raw.input_tp), silenceSegments });
  };
}
