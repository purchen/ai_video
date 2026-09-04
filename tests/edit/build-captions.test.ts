import { describe, expect, it } from 'vitest';
import { buildCaptions } from '../../src/edit/build-captions';
import { hashScript } from '../../src/script/hash-script';
import { fixture } from './fixtures';

function withText(text: string, durationMs = 21000) {
  const f = fixture();
  f.approvedScript.script.sentences[0].text = text;
  f.timings.approvedScriptHash = hashScript(f.approvedScript.script);
  return { script: f.approvedScript.script, timings: f.timings, options: { durationMs } };
}
describe('caption constraints', () => {
  it('preserves canonical characters, splits on punctuation and remains bounded', () => {
    const { script, timings, options } = withText('一二三四五六七八九，十甲乙丙丁戊己庚辛壬癸。');
    const cues = buildCaptions(script, timings, options);
    expect(cues[0].text).toBe('一二三四五六七八九');
    expect(cues.filter(c => c.scriptSentenceId === script.sentences[0].id).map(c => c.text).join('')).toBe('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸');
    cues.forEach((c, i) => {
      expect([...c.text.replace(/\n/g, '')].length).toBeLessThanOrEqual(18);
      expect(c.text.split('\n').length).toBeLessThanOrEqual(2);
      expect(c.endMs - c.startMs).toBeGreaterThanOrEqual(700);
      expect(c.startMs).toBeGreaterThanOrEqual(i ? cues[i - 1].endMs : 0);
      expect(c.endMs).toBeLessThanOrEqual(options.durationMs);
    });
  });
  it('accepts exactly 700ms and rejects insufficient total time without truncating', () => {
    const f = withText('甲', 4900);
    f.script.sentences.forEach(s => { s.text = '甲'; });
    f.timings.approvedScriptHash = hashScript(f.script);
    expect(buildCaptions(f.script, f.timings, f.options)).toHaveLength(7);
    expect(() => buildCaptions(f.script, f.timings, { durationMs: 4899 })).toThrow(/700|duration/i);
  });
  it('aligns provider words and rejects rewritten, overlapping, stale or out of range timings', () => {
    const f = withText('甲');
    f.script.sentences.forEach(s => { s.text = '甲乙。'; });
    f.timings.approvedScriptHash = hashScript(f.script);
    f.timings.mode = 'provider';
    f.timings.words = Array.from({ length: 7 }, (_, i) => ({ word: '甲乙', startMs: i * 2000 + 100, endMs: i * 2000 + 1000 }));
    const cues = buildCaptions(f.script, f.timings, f.options);
    expect(cues[0]).toMatchObject({ text: '甲乙', startMs: 100, endMs: 1000 });
    for (const words of [[{ ...f.timings.words[0], word: '改稿' }, ...f.timings.words.slice(1)], f.timings.words.map(w => ({ ...w, startMs: 0 })), f.timings.words.map(w => ({ ...w, endMs: w.endMs + 21000 }))]) expect(() => buildCaptions(f.script, { ...f.timings, words }, f.options)).toThrow();
    expect(() => buildCaptions(f.script, { ...f.timings, approvedScriptHash: 'a'.repeat(64) }, f.options)).toThrow();
  });
  it('does not silently cut long provider words or punctuation-only narration', () => {
    const f = withText('甲'.repeat(19));
    expect(() => buildCaptions(f.script, { ...f.timings, mode: 'provider', words: [{ word: '甲'.repeat(19), startMs: 0, endMs: 2000 }] }, f.options)).toThrow();
    const p = withText('？！');
    expect(() => buildCaptions(p.script, p.timings, p.options)).toThrow();
  });
});
