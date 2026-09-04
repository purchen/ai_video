export function compositionMetadata(voice: { durationMs: number }) {
  if (!Number.isFinite(voice.durationMs) || voice.durationMs <= 0)
    throw new Error('positive voice duration required');
  return {
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: Math.ceil((voice.durationMs / 1000) * 30),
  };
}
