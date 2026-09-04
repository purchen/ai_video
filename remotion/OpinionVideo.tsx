import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import type { EditPlan } from '../src/edit/build-edit-plan';
import { KineticText } from './components/KineticText';
import { SourceCard } from './components/SourceCard';
import { Captions } from './components/Captions';

export type OpinionProps = { plan?: EditPlan; media: Record<string, string> };
export function Scene({
  scene,
  frame,
  media,
}: {
  scene: EditPlan['scenes'][number];
  frame: number;
  media: Record<string, string>;
}) {
  const visual = scene.visual;
  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          top: 260,
          left: 96,
          right: 160,
          bottom: 620,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        {visual.kind === 'kinetic-text' ? (
          <KineticText text={visual.text} frame={frame} />
        ) : visual.kind === 'source-card' ? (
          <SourceCard sources={visual.sources} />
        ) : visual.kind === 'authorized-clip' ? (
          <OffthreadVideo
            src={staticFile(media[visual.asset.path])}
            muted
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : (
          <Img
            src={staticFile(media[visual.asset.path])}
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        )}
      </div>
      {scene.publicQuestionLabel && (
        <div
          style={{
            position: 'absolute',
            top: 190,
            left: 96,
            right: 160,
            color: '#f4ce86',
            fontSize: 30,
          }}
        >
          {scene.publicQuestionLabel}
        </div>
      )}
    </AbsoluteFill>
  );
}
export function OpinionVideo({ plan, media }: OpinionProps) {
  const frame = useCurrentFrame();
  const [fontHandle] = useState(() =>
    delayRender('Load bundled OFL Chinese font'),
  );
  useEffect(() => {
    const text = JSON.stringify(plan ?? {});
    document.fonts
      .load('400 48px "Noto Sans SC"', text)
      .then(() => document.fonts.ready)
      .then(() => continueRender(fontHandle))
      .catch(cancelRender);
  }, [fontHandle, plan]);
  if (!plan)
    return (
      <AbsoluteFill
        style={{
          background: '#0c1c25',
          color: 'white',
          padding: 100,
          fontFamily: '"Noto Sans SC"',
        }}
      >
        请通过正式项目渲染命令载入已批准的 edit-plan。
      </AbsoluteFill>
    );
  return (
    <AbsoluteFill
      style={{
        background: '#0c1c25',
        color: '#f6f3e9',
        fontFamily: '"Noto Sans SC"',
        fontWeight: 400,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 108,
          left: 96,
          fontSize: 27,
          letterSpacing: 4,
          color: '#65d6ba',
        }}
      >
        事实 · 机制 · 判断
      </div>
      {plan.scenes.map((scene) => {
        const from = Math.ceil((scene.startMs / 1000) * 30);
        const end = Math.ceil((scene.endMs / 1000) * 30);
        return (
          <Sequence key={scene.id} from={from} durationInFrames={end - from}>
            <Scene scene={scene} frame={frame - from} media={media} />
          </Sequence>
        );
      })}
      <Captions cues={plan.captions} timeMs={(frame / 30) * 1000} />
      <Audio src={staticFile(media[plan.voice.masterPath])} />
      {plan.music.mode === 'ambient' && (
        <Audio
          src={staticFile(media[plan.music.asset.path])}
          loop
          volume={10 ** (plan.music.relativeGainDb / 20)}
        />
      )}
    </AbsoluteFill>
  );
}
