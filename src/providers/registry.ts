import { hasConfiguredValue, type ProviderConfig } from '../config';
import type { ManualTtsAdapter, TtsAdapter, TtsRequest } from './contracts';
import { JianyingManualTtsAdapter } from './tts/manual';
import { OpenAiTtsAdapter, type FetchLike } from './tts/openai';

export interface TtsCapability {
  id: string;
  mode: 'direct' | 'manual';
}

export interface ProviderCapabilities {
  tts: readonly TtsCapability[];
}

export class ProviderRegistry implements ProviderCapabilities {
  readonly tts: readonly TtsCapability[];
  private readonly ttsAdapters: readonly (TtsAdapter | ManualTtsAdapter)[];

  private constructor(ttsAdapters: readonly (TtsAdapter | ManualTtsAdapter)[]) {
    this.ttsAdapters = ttsAdapters;
    this.tts = ttsAdapters.map((adapter) => ({
      id: adapter.id,
      mode: adapter.mode,
    }));
  }

  static detect(config: ProviderConfig, dependencies: { fetch?: FetchLike } = {}): ProviderRegistry {
    const adapters: Array<TtsAdapter | ManualTtsAdapter> = [];
    if (hasConfiguredValue(config.OPENAI_API_KEY)) {
      adapters.push(new OpenAiTtsAdapter({ apiKey: config.OPENAI_API_KEY, fetch: dependencies.fetch }));
    }
    adapters.push(new JianyingManualTtsAdapter());
    return new ProviderRegistry(adapters);
  }

  static fromTtsAdapters(adapters: readonly (TtsAdapter | ManualTtsAdapter)[]): ProviderRegistry {
    return new ProviderRegistry([...adapters]);
  }

  selectTts(_request: TtsRequest): TtsAdapter | ManualTtsAdapter {
    const adapter = this.ttsAdapters[0];
    if (!adapter) throw new Error('No TTS capability is registered');
    return adapter;
  }

  async selectAvailableTts(request: TtsRequest): Promise<TtsAdapter | ManualTtsAdapter> {
    for (const adapter of this.ttsAdapters) {
      if (await adapter.available()) return adapter;
    }
    throw new Error(`No TTS capability is available for script ${request.approvedScriptHash}`);
  }
}
