import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../src/providers/registry';

describe('ProviderRegistry', () => {
  it('prefers a configured direct TTS and keeps manual Jianying fallback', () => {
    const registry = ProviderRegistry.detect({ OPENAI_API_KEY: 'test', PROJECT_BUDGET_CNY: '5' });

    expect(registry.tts.map((item) => item.id)).toEqual(['openai-tts', 'jianying-manual']);
  });

  it('returns only manual fallback when no direct provider is configured', () => {
    const registry = ProviderRegistry.detect({});

    expect(registry.tts.map((item) => item.id)).toEqual(['jianying-manual']);
  });

  it('selects the configured direct TTS before the manual fallback', () => {
    const registry = ProviderRegistry.detect({ OPENAI_API_KEY: 'test' });

    expect(registry.selectTts({
      approvedScriptHash: 'a'.repeat(64),
      text: 'Test narration',
      voiceId: 'alloy',
      outputPath: 'voice/master.wav',
    }).id).toBe('openai-tts');
  });

  it('selects the manual Jianying fallback without a direct provider', () => {
    const registry = ProviderRegistry.detect({});

    expect(registry.selectTts({
      approvedScriptHash: 'a'.repeat(64),
      text: 'Test narration',
      voiceId: 'alloy',
      outputPath: 'voice/master.wav',
    }).id).toBe('jianying-manual');
  });
});
