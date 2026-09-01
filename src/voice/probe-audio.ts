import { execFile as nodeExecFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

export const audioMetadataSchema = z.object({
  durationMs: z.number().int().positive(),
  sampleRateHz: z.number().int().positive(),
  channels: z.number().int().positive(),
  integratedLufs: z.number().finite().nullable(),
});

export type AudioMetadata = z.infer<typeof audioMetadataSchema>;

export interface AudioProbe {
  probe(audioPath: string): Promise<AudioMetadata>;
}

export interface AudioConverter {
  convertToWav48k(inputPath: string, outputPath: string): Promise<void>;
}

type ExecFile = (
  executable: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

export function createFfprobeAudioProbe(executablePath: string, execFile: ExecFile = execute): AudioProbe {
  assertManagedExecutable(executablePath, 'ffprobe');
  return {
    async probe(audioPath) {
      const { stdout } = await execFile(executablePath, [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,channels:format=duration',
        '-of', 'json',
        audioPath,
      ]);
      const parsed = z.object({
        streams: z.array(z.object({ sample_rate: z.coerce.number(), channels: z.coerce.number() })).min(1),
        format: z.object({ duration: z.coerce.number() }),
      }).parse(JSON.parse(stdout));
      return audioMetadataSchema.parse({
        durationMs: Math.round(parsed.format.duration * 1000),
        sampleRateHz: parsed.streams[0].sample_rate,
        channels: parsed.streams[0].channels,
        integratedLufs: null,
      });
    },
  };
}

export function createFfmpegAudioConverter(executablePath: string, execFile: ExecFile = execute): AudioConverter {
  assertManagedExecutable(executablePath, 'ffmpeg');
  return {
    async convertToWav48k(inputPath, outputPath) {
      await execFile(executablePath, [
        '-y', '-i', inputPath,
        '-vn', '-ar', '48000', '-c:a', 'pcm_s16le',
        outputPath,
      ]);
    },
  };
}

function assertManagedExecutable(executablePath: string, tool: 'ffmpeg' | 'ffprobe'): void {
  if (!isAbsolute(executablePath)) {
    throw new Error(`${tool} executable path must be explicit and absolute`);
  }
}

function execute(executable: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    nodeExecFile(executable, [...args], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}
