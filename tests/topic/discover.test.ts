import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFeedTopicAdapter } from '../../src/providers/topic/json-feed';
import type { RawTopic, TopicSourceAdapter } from '../../src/providers/contracts';
import { discoverTopics, topicCandidatesArtifactSchema, type DiscoverTopicsOptions } from '../../src/topic/discover';

const fixturePath = fileURLToPath(new URL('../fixtures/topic-feed.json', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixtureAdapter = new JsonFeedTopicAdapter({
  id: 'fixture-feed',
  url: 'https://public.example.org/feed.json',
  fetchJson: async () => JSON.parse(await readFile(fixturePath, 'utf8')) as RawTopic[],
});

const defaultOptions = {
  count: 5,
  lane: ['社会观察', '生活态度', '思考辩论'],
  now: new Date('2026-09-01T08:00:00+08:00'),
  outputPath: join(tmpdir(), 'short-video-topic-candidates.json'),
} satisfies DiscoverTopicsOptions;

describe('discoverTopics', () => {
  it('rejects fewer than five unique inputs without publishing an incomplete candidate artifact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'short-video-insufficient-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'topic-candidates.json');
    const topic = { title: '测试主题', url: 'https://example.com/one', publisher: 'fixture' };
    await expect(discoverTopics([{ id: 'one-topic', fetch: async () => [topic, topic, topic, topic, topic] }], { ...defaultOptions, outputPath })).rejects.toThrow(/at least five unique/);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(topicCandidatesArtifactSchema.safeParse({ schemaVersion: 1, candidates: [] }).success).toBe(false);
  });

  it.each([
    ['糖尿病患者是否应该停药', 'medical'], ['劳动合同纠纷如何起诉', 'legal'],
    ['投资股票应该如何选', 'investment'], ['洪水预警后如何避险', 'public-safety'],
  ])('routes %s to elevated-risk human review', async (title, risk) => {
    const topics = [title, '下班后的阅读习惯', '周末的散步路线', '整理旧照片', '咖啡杯的颜色'].map((title, i) => ({ title, url: `https://example.com/triage/${i}`, publisher: 'fixture' }));
    const candidates = await discoverTopics([{ id: 'risk-cases', fetch: async () => topics }], defaultOptions);
    expect(candidates.find(c => c.title === title)).toMatchObject({ risks: [risk], eligibleForRecommendation: false, score: { risk: 5 } });
    expect(candidates.find(c => c.title === '下班后的阅读习惯')).toMatchObject({ risks: [], eligibleForRecommendation: true });
  });
  it('deduplicates equivalent headlines and ranks evidence-ready questions first', async () => {
    const candidates = await discoverTopics([fixtureAdapter], defaultOptions);

    expect(candidates).toHaveLength(5);
    expect(new Set(candidates.map((item) => item.normalizedTopic)).size).toBe(5);
    expect(candidates[0].questionHook).toMatch(/[？?]$/);
    expect(candidates[0].score.evidenceAvailability).toBeGreaterThanOrEqual(3);
  });
  it('retains elevated risk when a duplicate safe headline otherwise has the higher score', async () => {
    const raw = { title: '夜校报名延长', url: 'https://example.com/safe', publisher: '官方', summary: '官方公告' };
    const candidates = await discoverTopics([{ id: 'merged-risk', fetch: async () => [raw, { ...raw, url: 'https://example.com/risk', summary: '医疗患者参与' }, ...['阅读', '散步', '收纳', '摄影'].map((title, i) => ({ ...raw, title, summary: '', url: `https://example.com/${i}` }))] }], defaultOptions);
    expect(candidates.find(c => c.title === raw.title)).toMatchObject({ risks: ['medical'], eligibleForRecommendation: false, score: { risk: 5 } });
  });

  it('flags minors and unsupported allegations for human review', async () => {
    const highRiskFixture: TopicSourceAdapter = {
      id: 'high-risk-fixture',
      async fetch() {
        return [{
          title: '家长称某校教师伤害未成年学生',
          url: 'https://public.example.org/allegation',
          publisher: '匿名爆料',
          publishedAt: '2026-09-01T00:00:00.000Z',
          summary: '社交媒体流传的一则说法，未提供公开证据。',
        }];
      },
    };

    const candidates = await discoverTopics([highRiskFixture, fixtureAdapter], { ...defaultOptions, count: 10 });
    const candidate = candidates.find(c => c.title === '家长称某校教师伤害未成年学生')!;

    expect(candidate.risks).toEqual(expect.arrayContaining(['minor', 'unsupported-allegation']));
    expect(candidate.eligibleForRecommendation).toBe(false);
  });

  it('writes a validated versioned envelope to the explicit artifact path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'short-video-topic-artifact-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'project', 'topic-candidates.json');

    const candidates = await discoverTopics([fixtureAdapter], { ...defaultOptions, outputPath });
    const artifact = JSON.parse(await readFile(outputPath, 'utf8'));

    expect(artifact).toEqual({ schemaVersion: 1, candidates });
  });

  it.each([5, 10])('accepts the supported candidate count %i', async (count) => {
    await expect(discoverTopics([fixtureAdapter], { ...defaultOptions, count })).resolves.toBeInstanceOf(Array);
  });

  it.each([4, 11])('rejects unsupported candidate count %i before writing an artifact', async (count) => {
    const directory = await mkdtemp(join(tmpdir(), 'short-video-topic-count-'));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, 'topic-candidates.json');

    await expect(discoverTopics([fixtureAdapter], { ...defaultOptions, count, outputPath })).rejects.toThrow('count must be between 5 and 10');
    await expect(readFile(outputPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
