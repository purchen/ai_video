import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveManagedMediaTools } from '../../src/render/media-tools';
import { createFfmpegAudioAnalyzer } from '../../src/voice/analyze-audio';

// Deterministic PCM inputs exercise the bundled binary, not canned measurements.
it('measures true peaks, silence and actual post-gain looped music loudness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audio-qc-'));
  try {
    const tools = await resolveManagedMediaTools();
    const analyze = createFfmpegAudioAnalyzer(tools.ffmpeg);
    const tone = join(root, 'tone.wav'), silent = join(root, 'silence.wav'), clipped = join(root, 'clipped.wav');
    await writeFile(tone, wav(4, i => Math.sin(2 * Math.PI * 440 * i / 48000) * 0.1));
    await writeFile(silent, wav(4, () => 0));
    await writeFile(clipped, wav(4, i => Math.sin(2 * Math.PI * 440 * i / 48000) >= 0 ? 1 : -1));
    const nominal = await analyze(tone);
    expect((await tools.probe.probe(tone)).integratedLufs).toBeCloseTo(-23.75, 0);
    expect(nominal.integratedLufs).toBeCloseTo(-23.75, 0);
    expect(nominal.truePeakDbtp).toBeCloseTo(-20, 0);
    expect(nominal.silenceSegments).toEqual([]);
    const quiet = await analyze(tone, { gainDb: -16, durationMs: 6000, loop: true });
    expect(quiet.integratedLufs! - nominal.integratedLufs!).toBeCloseTo(-16, 0);
    const silence = await analyze(silent);
    expect(silence.integratedLufs).toBeNull();
    expect(silence.silenceSegments[0]).toMatchObject({ startMs: 0, endMs: 4000 });
    expect((await analyze(clipped)).truePeakDbtp).toBeGreaterThanOrEqual(0);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

function wav(seconds: number, sample: (i: number) => number) {
  const length = 48000 * seconds, bytes = Buffer.alloc(44 + length * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample(i))) * 32767), 44 + i * 2);
  return bytes;
}
