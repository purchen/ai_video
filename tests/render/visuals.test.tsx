import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { buildEditPlan } from '../../src/edit/build-edit-plan';
import { fixture } from '../edit/fixtures';
import { SourceCard } from '../../remotion/components/SourceCard';
import { Scene } from '../../remotion/OpinionVideo';

it('renders factual title, publisher, labeled date and captions above the bottom safe area', async () => {
  const source = {
    ...fixture().sources[0],
    publishedAt: '2026-08-15T00:00:00.000Z',
  };
  const html = renderToStaticMarkup(<SourceCard sources={[source]} />);
  expect(html).toContain('公告');
  expect(html).toContain('官方');
  expect(html).toContain('发布 2026-08-15');
  const captions = await import('../../remotion/components/Captions');
  const captionHtml = renderToStaticMarkup(
    <captions.Captions cues={buildEditPlan(fixture()).captions} timeMs={100} />,
  );
  expect(captionHtml).toContain('bottom:320px');
  expect(captionHtml).toContain('你怎么看这件事情');
});

it('always places public-question label outside the selected visual variant', async () => {
  const plan = buildEditPlan(fixture());
  const asset = {
    assetId: 'a',
    path: 'assets/a.mp4',
    permissionRecord: {
      schemaVersion: 1 as const,
      assetId: 'a',
      reference: 'licenses/a.txt',
    },
  };
  for (const visual of [
    plan.scenes[0].visual,
    plan.scenes[1].visual,
    { kind: 'authorized-clip', asset },
    {
      kind: 'ai-abstract',
      asset: {
        ...asset,
        path: 'assets/a.png',
        generationRecord: {
          schemaVersion: 1,
          assetId: 'a',
          provider: 'offline',
          reference: 'generation/a.json',
        },
      },
    },
  ] as const) {
    // Inspect the actual scene-level sibling; Remotion video needs a browser audio context.
    // The real-render test covers the full authorized-clip scene in that context.
    const element = Scene({
      scene: {
        ...plan.scenes[0],
        publicQuestionLabel: '公众疑问（非事实证据）',
        visual,
      },
      frame: 15,
      media: { 'assets/a.mp4': 'a.mp4', 'assets/a.png': 'a.png' },
    });
    const html = renderToStaticMarkup(element.props.children[1]);
    expect(html).toContain('公众疑问（非事实证据）');
  }
});
