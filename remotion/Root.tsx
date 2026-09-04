import React from 'react';
import { Composition, registerRoot } from 'remotion';
import '@fontsource/noto-sans-sc/400.css';
import { OpinionVideo, type OpinionProps } from './OpinionVideo';
import { compositionMetadata } from './metadata';

export function Root() {
  return (
    <Composition
      id="OpinionVideo"
      component={OpinionVideo}
      defaultProps={{ media: {} }}
      width={1080}
      height={1920}
      fps={30}
      durationInFrames={180}
      calculateMetadata={({ props }: { props: OpinionProps }) =>
        compositionMetadata(props.plan?.voice ?? { durationMs: 6000 })
      }
    />
  );
}
registerRoot(Root);
