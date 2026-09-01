import { writeFile } from 'node:fs/promises';
import type { CostEstimate, TtsAdapter, TtsRequest, TtsResult } from '../contracts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenAiTtsOptions {
  apiKey?: string;
  fetch?: FetchLike;
  model?: string;
  costCnyPerThousandCharacters?: number;
}

export class OpenAiTtsAdapter implements TtsAdapter {
  readonly id = 'openai-tts';
  readonly mode = 'direct' as const;
  private readonly apiKey?: string;
  private readonly fetch: FetchLike;
  private readonly model: string;
  private readonly costCnyPerThousandCharacters: number;

  constructor(options: OpenAiTtsOptions) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.model = options.model ?? 'tts-1';
    this.costCnyPerThousandCharacters = options.costCnyPerThousandCharacters ?? 0.108;
  }

  supports(request: TtsRequest): boolean {
    return request.voiceKind === 'synthetic' && request.authorization === 'synthetic';
  }

  async available(): Promise<boolean> {
    return this.apiKey !== undefined;
  }

  async estimate(request: TtsRequest): Promise<CostEstimate> {
    const characters = Array.from(request.text).length;
    return {
      providerId: this.id,
      currency: 'CNY',
      amount: Number(((characters / 1000) * this.costCnyPerThousandCharacters).toFixed(6)),
      basis: `${characters} Unicode characters at ${this.costCnyPerThousandCharacters} CNY/1k characters`,
    };
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (!this.apiKey) throw new Error('OpenAI TTS is unavailable without OPENAI_API_KEY');
    const response = await this.fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        voice: request.voiceId,
        input: request.text,
        response_format: 'wav',
      }),
    });
    if (!response.ok) throw new Error(`OpenAI TTS request failed with status ${response.status}`);
    await writeFile(request.outputPath, Buffer.from(await response.arrayBuffer()));
    const calculatedCost = await this.estimate(request);
    return {
      audioPath: request.outputPath,
      durationMs: 0,
      providerId: this.id,
      model: this.model,
      voiceId: request.voiceId,
      voiceKind: request.voiceKind,
      authorization: 'synthetic',
      authorizationReference: request.authorizationReference,
      authorizationHash: request.authorizationHash,
      cost: {
        ...calculatedCost,
        basis: `configured calculation; not provider-reported invoice; ${calculatedCost.basis}`,
      },
    };
  }
}
