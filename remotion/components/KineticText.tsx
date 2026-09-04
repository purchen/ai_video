import React from 'react';

export function KineticText({ text, frame }: { text: string; frame: number }) {
  const progress = Math.min(1, Math.max(0, frame / 12));
  return (
    <div
      style={{
        fontSize: 74,
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        opacity: progress,
        transform: `translateY(${(1 - progress) * 28}px) scale(${0.97 + 0.03 * progress})`,
      }}
    >
      {text}
    </div>
  );
}
