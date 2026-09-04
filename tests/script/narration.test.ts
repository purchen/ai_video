import { describe, expect, it } from 'vitest';
import { sectionOrder } from '../../src/script/build-script';
import { scriptNarrationText } from '../../src/script/narration';

const createdAt = '2026-09-01T00:00:00.000Z';

const script = {
  schemaVersion: 1 as const,
  id: 'script-001',
  projectId: 'topic-001',
  title: '夜校服务的改变',
  sections: sectionOrder.map((type) => ({
    type,
    sentenceIds: type === 'mechanism'
      ? ['sentence-mechanism-a', 'sentence-mechanism-b']
      : [`sentence-${type}`],
    lenses: type === 'mechanism' ? ['user-experience'] : [],
  })),
  sentences: [
    { id: 'sentence-closing-question', text: '你怎么看？', type: 'call-to-action' as const, sourceIds: [] },
    { id: 'sentence-judgment', text: '这是我们的判断。', type: 'opinion' as const, sourceIds: [] },
    { id: 'sentence-counter-evidence', text: '反面证据也要看。', type: 'transition' as const, sourceIds: [] },
    { id: 'sentence-mechanism-b', text: '机制第二句。', type: 'transition' as const, sourceIds: [] },
    { id: 'sentence-mechanism-a', text: '机制第一句。', type: 'transition' as const, sourceIds: [] },
    { id: 'sentence-strong-evidence', text: '这是强证据。', type: 'transition' as const, sourceIds: [] },
    { id: 'sentence-fact-baseline', text: '事实基线。', type: 'fact' as const, sourceIds: ['official-1'], attribution: '官方' },
    { id: 'sentence-question-hook', text: '这件事改变了什么？', type: 'hook' as const, sourceIds: [] },
  ],
  estimatedDurationMs: 90_000,
  createdAt,
  updatedAt: createdAt,
};

describe('scriptNarrationText', () => {
  it('uses fixed section order and each section sentenceIds order', () => {
    expect(scriptNarrationText(script)).toBe([
      '这件事改变了什么？',
      '事实基线。',
      '这是强证据。',
      '机制第一句。\n机制第二句。',
      '反面证据也要看。',
      '这是我们的判断。',
      '你怎么看？',
    ].join('\n\n'));
  });

  it('rejects a sentence referenced more than once', () => {
    const sections = script.sections.map((section) => section.type === 'closing-question'
      ? { ...section, sentenceIds: ['sentence-question-hook'] }
      : section);

    expect(() => scriptNarrationText({ ...script, sections })).toThrow(
      'sentence sentence-question-hook is referenced more than once',
    );
  });

  it('rejects a missing referenced sentence', () => {
    const sections = script.sections.map((section) => section.type === 'closing-question'
      ? { ...section, sentenceIds: ['sentence-missing'] }
      : section);

    expect(() => scriptNarrationText({ ...script, sections })).toThrow(
      'section closing-question references unknown sentence sentence-missing',
    );
  });

  it('rejects an unreferenced sentence', () => {
    const sentences = [
      ...script.sentences,
      { id: 'sentence-extra', text: '不应被漏掉。', type: 'transition' as const, sourceIds: [] },
    ];

    expect(() => scriptNarrationText({ ...script, sentences })).toThrow(
      'sentence sentence-extra is not referenced by any section',
    );
  });
});
