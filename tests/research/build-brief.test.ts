import { describe, expect, it } from 'vitest';
import { buildResearchBrief } from '../../src/research/build-brief';
import type { SourceRecord } from '../../src/domain/schemas';
import type { TopicCandidate } from '../../src/topic/discover';

const capturedAt = '2026-09-01T00:00:00.000Z';

const topic: TopicCandidate = {
  title: '城市夜校报名服务延长',
  normalizedTopic: '城市夜校|报名服务|2026-09-01',
  questionHook: '城市夜校的报名服务，究竟改变了什么？',
  sourceUrls: [],
  sourcePublishers: [],
  risks: [],
  eligibleForRecommendation: true,
  score: { relevance: 5, tension: 4, evidenceAvailability: 5, independentJudgment: 5, laneFit: 5, visualDifficulty: 2, risk: 1, total: 4.5 },
};

function source(id: string, sourceType: SourceRecord['sourceType'], summary: string): SourceRecord {
  return {
    schemaVersion: 1,
    id,
    url: `https://example.com/${id}`,
    title: id,
    publisher: 'Example',
    summary,
    sourceType,
    evidenceWeight: 'high',
    capturedAt,
  };
}

describe('buildResearchBrief', () => {
  it('does not promote comment samples into confirmed facts', () => {
    const commentOnlySource = source('comment-1', 'comment-sample', '有人担心夜校名额不够。');

    const brief = buildResearchBrief(topic, [commentOnlySource]);

    expect(brief.confirmedFacts).toHaveLength(0);
    expect(brief.publicQuestions).toContain(commentOnlySource.summary);
    expect(brief.status).toBe('BLOCKED_EVIDENCE');
  });

  it('keeps conflicting claims visible and blocks silent resolution', () => {
    const sourceA = {
      ...source('source-a', 'official-data', '官方公告称夜校报名服务已延长。'),
      claim: { key: 'night-school-registration-extended', value: 'affirmed' as const, text: '夜校报名服务已延长。' },
    };
    const sourceB = {
      ...source('source-b', 'professional-media', '报道说报名服务尚未延长。'),
      claim: { key: 'night-school-registration-extended', value: 'denied' as const, text: '夜校报名服务尚未延长。' },
    };

    const brief = buildResearchBrief(topic, [sourceA, sourceB]);

    expect(brief.conflicts[0].sourceIds).toEqual(['source-a', 'source-b']);
    expect(brief.conflicts[0].resolution).toBe('unresolved');
    expect(brief.canDraftScript).toBe(false);
  });

  it('uses expert material for explanation notes rather than event-fact confirmation', () => {
    const expertSource = {
      ...source('expert-1', 'expert-analysis', '专家解释延长服务可能降低报名摩擦。'),
      claim: { key: 'night-school-registration-extended', value: 'affirmed' as const, text: '夜校报名服务已延长。' },
    };

    const brief = buildResearchBrief(topic, [expertSource]);

    expect(brief.confirmedFacts).toHaveLength(0);
    expect(brief.explanationNotes).toEqual([{ sourceId: 'expert-1', text: expertSource.claim.text }]);
  });
});
