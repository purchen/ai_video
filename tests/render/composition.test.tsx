import { expect, it } from 'vitest';
import { compositionMetadata } from '../../remotion/metadata';

it('derives vertical composition frame count from voice duration, rounding up the last frame', async () => {
  expect(compositionMetadata({ durationMs: 6001 })).toEqual({
    width: 1080,
    height: 1920,
    fps: 30,
    durationInFrames: 181,
  });
});
