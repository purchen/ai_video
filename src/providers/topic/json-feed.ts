import type { RawTopic, TopicSourceAdapter } from '../contracts';

export interface JsonFeedTopicAdapterOptions {
  id: string;
  url: string;
  fetchJson?: (url: string) => Promise<unknown>;
}

/** A public JSON-feed adapter; callers may inject fetching for offline runs and tests. */
export class JsonFeedTopicAdapter implements TopicSourceAdapter {
  readonly id: string;
  private readonly url: string;
  private readonly fetchJson: (url: string) => Promise<unknown>;

  constructor(options: JsonFeedTopicAdapterOptions) {
    this.id = options.id;
    this.url = options.url;
    this.fetchJson = options.fetchJson ?? fetchPublicJson;
  }

  async fetch(window: { from: Date; to: Date }): Promise<RawTopic[]> {
    const payload = await this.fetchJson(this.url);
    const topics = extractTopics(payload);

    return topics.filter((topic) => {
      if (!topic.publishedAt) return true;
      const publishedAt = new Date(topic.publishedAt);
      return Number.isNaN(publishedAt.getTime()) || (publishedAt >= window.from && publishedAt <= window.to);
    });
  }
}

async function fetchPublicJson(url: string): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('JsonFeedTopicAdapter only supports public HTTP(S) JSON sources');
  }

  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`JSON feed request failed: ${response.status}`);
  return response.json();
}

function extractTopics(payload: unknown): RawTopic[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : [];

  return values.flatMap((value) => isRawTopic(value) ? [value] : []);
}

function isRawTopic(value: unknown): value is RawTopic {
  return isRecord(value)
    && typeof value.title === 'string'
    && typeof value.url === 'string'
    && typeof value.publisher === 'string'
    && (value.publishedAt === undefined || typeof value.publishedAt === 'string')
    && (value.summary === undefined || typeof value.summary === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
