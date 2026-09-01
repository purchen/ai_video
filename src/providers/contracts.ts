import type { ScriptDocument, SourceRecord } from '../domain/schemas';

export interface CostEstimate {
  providerId: string;
  currency: 'CNY';
  amount: number;
  basis: string;
}

export interface TtsRequest {
  approvedScriptHash: string;
  text: string;
  voiceId: string;
  outputPath: string;
}

export interface TtsResult {
  audioPath: string;
  durationMs: number;
  providerId: string;
  model: string;
  voiceId: string;
  authorization: 'synthetic' | 'user-authorized';
  cost: CostEstimate;
}

export interface TtsAdapter {
  readonly id: string;
  available(): Promise<boolean>;
  estimate(request: TtsRequest): Promise<CostEstimate>;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}

export interface ManualTtsAdapter extends TtsAdapter {
  readonly id: 'jianying-manual';
}

export interface RawTopic {
  title: string;
  url: string;
  publisher: string;
  publishedAt?: string;
  summary?: string;
}

export interface TopicSourceAdapter {
  readonly id: string;
  fetch(window: { from: Date; to: Date }): Promise<RawTopic[]>;
}

export interface ResearchInput {
  sources: SourceRecord[];
  script?: ScriptDocument;
}

export interface LanguageModelRequest {
  prompt: string;
  responseFormat: 'json';
  schemaName: 'ScriptDocument';
}

/** Network-agnostic boundary for deterministic or remote structured-output models. */
export interface LanguageModelAdapter {
  readonly id: string;
  generate(request: LanguageModelRequest): Promise<unknown>;
}
