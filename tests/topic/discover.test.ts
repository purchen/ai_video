import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFeedTopicAdapter } from '../../src/providers/topic/json-feed';
import type { RawTopic, TopicSourceAdapter } from '../../src/providers/contracts';
import { discoverTopics, type DiscoverTopicsOptions } from '../../src/topic/discover';

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
  it('deduplicates equivalent headlines and ranks evidence-ready questions first', async () => {
    const candidates = await discoverTopics([fixtureAdapter], defaultOptions);

    expect(candidates).toHaveLength(5);
    expect(new Set(candidates.map((item) => item.normalizedTopic)).size).toBe(5);
    expect(candidates[0].questionHook).toMatch(/[？?]$/);
    expect(candidates[0].score.evidenceAvailability).toBeGreaterThanOrEqual(3);
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

    const [candidate] = await discoverTopics([highRiskFixture], defaultOptions);

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
