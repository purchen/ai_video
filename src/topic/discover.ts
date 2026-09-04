import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { RawTopic, TopicSourceAdapter } from '../providers/contracts';

export type TopicLane = '社会观察' | '生活态度' | '思考辩论';
export class InsufficientTopicInputError extends Error {}

export interface TopicScore {
  relevance: number;
  tension: number;
  evidenceAvailability: number;
  independentJudgment: number;
  laneFit: number;
  visualDifficulty: number;
  risk: number;
  total: number;
}

export interface TopicCandidate {
  title: string;
  normalizedTopic: string;
  questionHook: string;
  sourceUrls: string[];
  sourcePublishers: string[];
  risks: string[];
  eligibleForRecommendation: boolean;
  score: TopicScore;
}

export interface DiscoverTopicsOptions {
  count: number;
  lane: TopicLane[];
  now: Date;
  windowHours?: number;
  outputPath: string;
}

const topicScoreSchema = z.object({
  relevance: z.number(),
  tension: z.number(),
  evidenceAvailability: z.number(),
  independentJudgment: z.number(),
  laneFit: z.number(),
  visualDifficulty: z.number(),
  risk: z.number(),
  total: z.number(),
});

const topicCandidateSchema = z.object({
  title: z.string(),
  normalizedTopic: z.string(),
  questionHook: z.string(),
  sourceUrls: z.array(z.string().url()),
  sourcePublishers: z.array(z.string()),
  risks: z.array(z.string()),
  eligibleForRecommendation: z.boolean(),
  score: topicScoreSchema,
});

export const topicCandidatesArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  candidates: z.array(topicCandidateSchema).min(5).max(10),
});

interface NormalizedTopic {
  entity: string;
  event: string;
  timeWindow: string;
  key: string;
}

interface ScoredTopic {
  raw: RawTopic;
  normalized: NormalizedTopic;
  risks: string[];
  score: TopicScore;
}

export async function discoverTopics(
  adapters: TopicSourceAdapter[],
  options: DiscoverTopicsOptions,
): Promise<TopicCandidate[]> {
  if (!Number.isInteger(options.count) || options.count < 5 || options.count > 10) {
    throw new Error('count must be between 5 and 10');
  }

  const windowHours = options.windowHours ?? 24;
  const window = { from: new Date(options.now.getTime() - windowHours * 60 * 60 * 1000), to: options.now };
  const sources = (await Promise.all(adapters.map((adapter) => adapter.fetch(window)))).flat();
  const grouped = new Map<string, ScoredTopic[]>();

  for (const raw of sources) {
    const normalized = normalizeTopic(raw, options.now);
    const risks = identifyRisks(raw);
    const score = scoreTopic(raw, options.lane, options.now, risks);
    const entries = grouped.get(normalized.key) ?? [];
    entries.push({ raw, normalized, risks, score });
    grouped.set(normalized.key, entries);
  }

  const candidates = [...grouped.values()]
    .map(toCandidate)
    .sort(compareCandidates)
    .slice(0, options.count);

  if (candidates.length < 5) throw new InsufficientTopicInputError(`insufficient evidence/input: at least five unique topic candidates are required; received ${candidates.length}`);
  const artifact = topicCandidatesArtifactSchema.parse({ schemaVersion: 1, candidates });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  return candidates;
}

function normalizeTopic(raw: RawTopic, now: Date): NormalizedTopic {
  const text = `${raw.title} ${raw.summary ?? ''}`.toLowerCase().replace(/\s+/g, '');
  const entity = findFirst(text, [
    ['城市夜校', '城市夜校'], ['夜校', '城市夜校'], ['社区食堂', '社区食堂'],
    ['公共图书馆', '公共图书馆'], ['图书馆', '公共图书馆'], ['无纸化挂号', '无纸化挂号'],
    ['旧衣回收', '旧衣回收'], ['公共自行车', '公共自行车'], ['未成年', '未成年人'], ['学生', '学生'],
  ]) ?? canonicalText(raw.title);
  const event = findFirst(text, [
    ['夜校', '夜校发展'], ['报名', '报名服务'], ['延长', '服务延长'], ['夜读', '夜读服务'],
    ['挂号', '医疗服务'], ['回收', '环保服务'], ['亲子座椅', '出行服务'], ['伤害', '伤害指控'], ['称', '指控'],
  ]) ?? canonicalText(raw.summary ?? raw.title);
  const published = raw.publishedAt ? new Date(raw.publishedAt) : now;
  const timeWindow = Number.isNaN(published.getTime()) ? dateKey(now) : dateKey(published);
  return { entity, event, timeWindow, key: `${entity}|${event}|${timeWindow}` };
}

function identifyRisks(raw: RawTopic): string[] {
  const text = `${raw.title} ${raw.summary ?? ''} ${raw.publisher}`.toLowerCase();
  const risks: string[] = [];
  if (/未成年|未成年人|儿童|孩子|学生|少年/.test(text)) risks.push('minor');
  // Conservative keyword triage, not diagnosis, advice or a semantic guarantee.
  if (/医疗|患者|疾病|糖尿病|癌症|停药|服药|药物|治疗|诊断|疫苗|手术/.test(text)) risks.push('medical');
  if (/法律|律师|法院|起诉|诉讼|劳动合同|违法|刑事|判决|仲裁/.test(text)) risks.push('legal');
  if (/投资|股票|基金|证券|理财|期货|加密货币|比特币|炒股/.test(text)) risks.push('investment');
  if (/公共安全|洪水|洪灾|地震|火灾|消防|爆炸|燃气泄漏|避险|疏散|应急救援/.test(text)) risks.push('public-safety');
  const allegation = /称|爆料|指控|传言|涉嫌|伤害|霸凌/.test(text);
  const supported = /官方|公告|通报|公开数据|法院|警方|调查结果/.test(text);
  if (allegation && !supported) risks.push('unsupported-allegation');
  return risks;
}

function scoreTopic(raw: RawTopic, lanes: TopicLane[], now: Date, risks: string[]): TopicScore {
  const text = `${raw.title} ${raw.summary ?? ''}`.toLowerCase();
  const published = raw.publishedAt ? new Date(raw.publishedAt) : now;
  const ageHours = Number.isNaN(published.getTime()) ? 24 : Math.max(0, (now.getTime() - published.getTime()) / 3_600_000);
  const evidenceAvailability = /公开数据|公告|通知|官方|试点|报名人数|流程/.test(text) ? 5 : raw.summary ? 3 : 2;
  const matchingLanes = lanes.filter((lane) => laneMatches(lane, text)).length;
  const relevance = ageHours <= 24 ? 5 : ageHours <= 72 ? 4 : 3;
  const tension = /为何|火爆|突然|延长|新增|覆盖|进入|伤害|称/.test(text) ? 4 : 3;
  const independentJudgment = risks.length > 0 ? 1 : /为何|如何|是否|火爆|新增|延长/.test(text) ? 5 : 4;
  const laneFit = matchingLanes > 0 ? 5 : 3;
  const visualDifficulty = /数据|流程|公告|课程|服务|试点/.test(text) ? 2 : 3;
  const risk = risks.length === 0 ? 1 : 5;
  const total = relevance * 0.22 + tension * 0.18 + evidenceAvailability * 0.24
    + independentJudgment * 0.16 + laneFit * 0.12 + (5 - visualDifficulty) * 0.04 + (5 - risk) * 0.04;
  return { relevance, tension, evidenceAvailability, independentJudgment, laneFit, visualDifficulty, risk, total };
}

function toCandidate(entries: ScoredTopic[]): TopicCandidate {
  const best = [...entries].sort((left, right) => right.score.total - left.score.total || lexical(left.raw.title, right.raw.title))[0];
  const risks = [...new Set(entries.flatMap((entry) => entry.risks))].sort(lexical);
  const risk = risks.length ? 5 : best.score.risk;
  return {
    title: best.raw.title,
    normalizedTopic: best.normalized.key,
    questionHook: questionHook(best.normalized),
    sourceUrls: [...new Set(entries.map((entry) => entry.raw.url))].sort(lexical),
    sourcePublishers: [...new Set(entries.map((entry) => entry.raw.publisher))].sort(lexical),
    risks,
    eligibleForRecommendation: risks.length === 0,
    score: { ...best.score, risk, total: best.score.total + (best.score.risk - risk) * 0.04 },
  };
}

function questionHook(topic: NormalizedTopic): string {
  return `${topic.entity}的${topic.event}，究竟改变了什么？`;
}

function laneMatches(lane: TopicLane, text: string): boolean {
  const terms: Record<TopicLane, RegExp> = {
    社会观察: /城市|社区|公共|服务|医院|图书馆|学校/,
    生活态度: /夜校|夜读|食堂|回收|出行|亲子/,
    思考辩论: /为何|是否|火爆|延长|新增|覆盖/,
  };
  return terms[lane].test(text);
}

function findFirst(text: string, values: Array<[string, string]>): string | undefined {
  return values.find(([needle]) => text.includes(needle))?.[1];
}

function canonicalText(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 24);
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function compareCandidates(left: TopicCandidate, right: TopicCandidate): number {
  return right.score.total - left.score.total
    || lexical(left.normalizedTopic, right.normalizedTopic)
    || lexical(left.title, right.title);
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
