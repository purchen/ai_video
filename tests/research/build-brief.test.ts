import { describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildResearchBrief, writeResearchArtifacts } from '../../src/research/build-brief';
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
  it('does not invent a fixed lens and requires an explicit relevant choice before drafting', () => {
    const official = { ...source('official', 'official-data', '明确事实'), claim: { key: 'fact', value: 'affirmed' as const, text: '明确事实' } };
    const brief = buildResearchBrief(topic, [official]);
    expect(brief.candidateLenses).toEqual([]);
    expect(brief.canDraftScript).toBe(false);
    expect(brief.unknowns.join(';')).toMatch(/lens/);
  });
  it('retains chosen source and common-sense explanations with applicability, without upgrading them to facts', () => {
    const lenses = [
      { id: 'psychology', label: '心理学', text: '解释选择压力', basis: 'source' as const, sourceIds: ['expert'], applicability: '仅作为机制假说，不证明本次动机' },
      { id: 'daily-choice', label: '生活常识', text: '先区分重要与紧急', basis: 'everyday-common-sense' as const, sourceIds: [], applicability: '仅作思考，不适用于紧急责任' },
    ];
    const sources = [source('expert', 'expert-analysis', '选择压力的解释'), { ...source('official', 'official-data', '明确事实'), claim: { key: 'fact', value: 'affirmed' as const, text: '明确事实' } }];
    const brief = buildResearchBrief(topic, sources, { lenses });
    expect(brief.candidateLenses).toEqual(['psychology', 'daily-choice']);
    expect(brief.chosenLenses).toEqual(lenses);
    expect(brief.confirmedFacts).toHaveLength(1);
    expect(brief.canDraftScript).toBe(true);
    expect(() => buildResearchBrief(topic, sources, { lenses: [{ ...lenses[0], sourceIds: ['unknown'] }] })).toThrow(/lens.*source/);
    expect(() => buildResearchBrief(topic, sources, { lenses: [{ ...lenses[0], applicability: '' }] })).toThrow();
  });
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

  it('keeps everyday common sense as a non-evidentiary explanation note', () => {
    const brief = buildResearchBrief(topic, [], {
      explanationNotes: [{
        kind: 'everyday-common-sense',
        text: '多一个服务时段通常会降低用户的时间安排压力。',
        lens: 'user-experience',
      }],
    });

    expect(brief.explanationNotes).toContainEqual({
      kind: 'everyday-common-sense',
      text: '多一个服务时段通常会降低用户的时间安排压力。',
      lens: 'user-experience',
    });
    expect(brief.confirmedFacts).toHaveLength(0);
    expect(brief.conflicts).toHaveLength(0);
  });

  it('writes a validated source envelope and required markdown sections', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'research-brief-'));
    const officialSource = {
      ...source('official-1', 'official-data', '官方公告称夜校报名服务已延长。'),
      claim: { key: 'night-school-registration-extended', value: 'affirmed' as const, text: '夜校报名服务已延长。' },
    };
    const brief = buildResearchBrief(topic, [officialSource]);

    try {
      await writeResearchArtifacts(brief, [officialSource], { outputDirectory });
      expect(JSON.parse(await readFile(join(outputDirectory, 'sources.json'), 'utf8'))).toMatchObject({
        schemaVersion: 1,
        sources: [{ id: 'official-1' }],
      });
      const markdown = await readFile(join(outputDirectory, 'research-brief.md'), 'utf8');
      for (const heading of ['## Confirmed facts', '## Conflicts', '## Unknowns', '## Candidate lenses', '## Risks']) {
        expect(markdown).toContain(heading);
      }
      expect(markdown).toContain('夜校报名服务已延长。');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  it('rejects malformed runtime sources before creating a JSON artifact', async () => {
    const outputDirectory = join(tmpdir(), `research-brief-invalid-${Date.now()}`);
    const brief = buildResearchBrief(topic, []);
    const malformedSource = { ...source('invalid-source', 'official-data', '无效来源。'), url: 'not-a-url' };

    await expect(writeResearchArtifacts(brief, [malformedSource], { outputDirectory })).rejects.toThrow();
    await expect(access(join(outputDirectory, 'sources.json'))).rejects.toThrow();
  });
});
