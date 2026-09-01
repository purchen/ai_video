import { hasConfiguredValue, type ProviderConfig } from '../config';
import type { CostEstimate, ManualTtsAdapter, TtsAdapter, TtsRequest, TtsResult } from './contracts';

export interface TtsCapability {
  id: 'openai-tts' | 'jianying-manual';
  mode: 'direct' | 'manual';
}

export interface ProviderCapabilities {
  tts: readonly TtsCapability[];
}

export class ProviderRegistry implements ProviderCapabilities {
  readonly tts: readonly TtsCapability[];

  private constructor(tts: readonly TtsCapability[]) {
    this.tts = tts;
  }

  static detect(config: ProviderConfig): ProviderRegistry {
    const tts: TtsCapability[] = [];
    if (hasConfiguredValue(config.OPENAI_API_KEY)) {
      tts.push({ id: 'openai-tts', mode: 'direct' });
    }
    tts.push({ id: 'jianying-manual', mode: 'manual' });
    return new ProviderRegistry(tts);
  }

  selectTts(_request: TtsRequest): TtsAdapter | ManualTtsAdapter {
    return this.tts[0]?.id === 'openai-tts' ? new OpenAiTtsCapability() : new JianyingManualCapability();
  }
}

class OpenAiTtsCapability implements TtsAdapter {
  readonly id = 'openai-tts';

  async available(): Promise<boolean> {
    return true;
  }

  async estimate(_request: TtsRequest): Promise<CostEstimate> {
    throw new Error('OpenAI TTS is not implemented');
  }

  async synthesize(_request: TtsRequest): Promise<TtsResult> {
    throw new Error('OpenAI TTS is not implemented');
  }
}

class JianyingManualCapability implements ManualTtsAdapter {
  readonly id = 'jianying-manual' as const;

  async available(): Promise<boolean> {
    return true;
  }

  async estimate(_request: TtsRequest): Promise<CostEstimate> {
    return { providerId: this.id, currency: 'CNY', amount: 0, basis: 'manual import' };
  }

  async synthesize(_request: TtsRequest): Promise<TtsResult> {
    throw new Error('Manual Jianying TTS requires an imported audio file');
  }
}
