import React from 'react';
import type { CaptionCue } from '../../src/edit/build-captions';

export function Captions({
  cues,
  timeMs,
}: {
  cues: CaptionCue[];
  timeMs: number;
}) {
  const cue = cues.find((c) => timeMs >= c.startMs && timeMs < c.endMs);
  if (!cue) return null;
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 320,
        left: 96,
        right: 160,
        textAlign: 'center',
        fontSize: 49,
        lineHeight: 1.5,
        color: '#ffffff',
        background: '#07151bea',
        borderRadius: 16,
        padding: '20px 24px',
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
      }}
    >
      {cue.text}
    </div>
  );
}
