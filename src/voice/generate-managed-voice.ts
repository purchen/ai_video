import { resolveManagedMediaTools } from '../render/media-tools';
import { generateVoice, type GenerateVoiceRequest } from './generate-voice';

/** Production entry point: the direct provider still receives the exact locked narration. */
export async function generateManagedVoice(
  request: Omit<GenerateVoiceRequest, 'probe' | 'converter'>,
) {
  const { probe, converter } = await resolveManagedMediaTools();
  return generateVoice({ ...request, probe, converter });
}
