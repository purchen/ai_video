import { approvedFixture, now } from '../voice/fixtures';
import { hashScript } from '../../src/script/hash-script';
import type { VoiceReport, WordTimings } from '../../src/voice/schemas';
import type { SourceRecord } from '../../src/domain/schemas';

export function fixture() {
  const approvedScript = approvedFixture();
  approvedScript.script.sentences.forEach((s, i) => { s.text = ['你怎么看这件事情？', '公告给出了最新数据。', '数据说明问题值得关注。', '接下来看看具体机制。', '也要注意不同的情况。', '我的判断仍需要检验。', '你会如何看待这个问题？'][i]; });
  approvedScript.script.sentences[2].type = 'fact';
  approvedScript.script.sentences[2].sourceIds = ['official-1'];
  approvedScript.scriptHash = hashScript(approvedScript.script);
  const voiceReport: VoiceReport = { schemaVersion: 1, status: 'READY', projectId: 'topic-001', transactionId: '00000000-0000-4000-8000-000000000003', approvedScriptHash: approvedScript.scriptHash, providerId: 'manual', model: 'manual', voiceId: 'original', voiceKind: 'synthetic', authorization: 'synthetic', authorizationReference: 'synthetic:original', authorizationHash: 'a'.repeat(64), durationMs: 21000, sampleRateHz: 48000, channels: 1, formatName: 'wav', codecName: 'pcm_s16le', integratedLufs: null, costCny: 0, generatedAt: now };
  const timings: WordTimings = { schemaVersion: 1, projectId: 'topic-001', approvedScriptHash: approvedScript.scriptHash, transactionId: voiceReport.transactionId, mode: 'fallback-empty', words: [] };
  const sources: SourceRecord[] = [{ schemaVersion: 1, id: 'official-1', url: 'https://example.com/notice', title: '公告', publisher: '官方', summary: '最新数据', sourceType: 'official-data', evidenceWeight: 'high', capturedAt: now }];
  return { approvedScript, voiceReport, timings, sources, assets: { schemaVersion: 1 as const, projectId: 'topic-001', assets: [] } };
}
