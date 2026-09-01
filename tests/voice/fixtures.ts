import { approvedScriptSchema, type ApprovedScript } from '../../src/review/approve';
import { hashScript } from '../../src/script/hash-script';

const now = '2026-09-01T00:00:00.000Z';

export function approvedFixture(): ApprovedScript {
  const sectionTypes = [
    'question-hook',
    'fact-baseline',
    'strong-evidence',
    'mechanism',
    'counter-evidence',
    'judgment',
    'closing-question',
  ] as const;
  const script = {
    schemaVersion: 1 as const,
    id: 'script-001',
    projectId: 'topic-001',
    title: '夜校服务的改变',
    sections: sectionTypes.map((type) => ({ type, sentenceIds: [`sentence-${type}`], lenses: [] })),
    sentences: sectionTypes.map((type) => ({
      id: `sentence-${type}`,
      text: `${type} 原样文案`,
      type: type === 'fact-baseline' ? 'fact' as const : 'transition' as const,
      sourceIds: type === 'fact-baseline' ? ['official-1'] : [],
      attribution: type === 'fact-baseline' ? '官方' : undefined,
    })),
    estimatedDurationMs: 90_000,
    createdAt: now,
    updatedAt: now,
  };
  return approvedScriptSchema.parse({
    schemaVersion: 1,
    transactionId: '00000000-0000-4000-8000-000000000001',
    approvedAt: now,
    approvedBy: 'editor',
    scriptHash: hashScript(script),
    script,
  });
}
