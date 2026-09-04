# Offline Chinese speech MVP fixture

Original thought-topic sample: 今天没做完，就算失败吗？ All diary examples and their source records are synthetic test data, not real news, interviews, statistics, or evidence about a real person. Both publisher and title on source cards visibly say 合成测试数据. The spoken opening also discloses the fixture, synthetic narration and fictional examples.

## What is preserved

- `narration.txt`: canonical locked narration, UTF-8 without BOM, LF, no trailing newline; identical to `scriptNarrationText` of `mvp-input.ts`.
- `speech.wav`: Windows System.Speech, Microsoft Huihui Desktop, zh-CN, rate 2, volume 100; 109040 ms, 22050 Hz mono PCM source. Not human, cloned, Jianying or OpenAI speech.
- `speech-provenance.json`: generation metadata and SHA-256 of the canonical text and original source WAV. Local synthesis, zero paid API calls. Preservation is for offline tests/inspection, not a representation that commercial distribution rights have been cleared.
- Official workflow artifacts: generated through the real orchestrator, including both approvals, committed 48000 Hz master, edit plan, rendered MP4 and QC. No artifact was hand-labeled COMPLETE.
- `reports/beginning.png`, `middle.png`, `end.png`: extracted at 3.000, 54.520 and 106.040 seconds. `reports/manual-review.md` distinguishes observed checks from unperformed listening/ASR.

## Reproduce on any supported host

Install locked dependencies and provision the Remotion browser explicitly with download approval as described in `docs/rendering.md`. Run from repository root:

```text
npm test -- tests/e2e/mvp.test.ts
npx tsx tests/fixtures/build-mvp-project.ts projects/fresh-mvp
```

The test uses the preserved WAV, checks its byte hash and canonical text, selects the actual Huihui identity through a fixture-only adapter, then uses real conversion/probing, approval readers, transactions, rendering and QC. It creates unique `projects/mvp-e2e/run-*/mvp-project` outputs and never changes this preserved project. The builder refuses a target containing `project.json`. No SAPI installation or paid API is required to replay it. No network asset is fetched; the example.invalid URL is metadata only. Tool/browser absence is an explicit failure rather than a skip or a download.

## Regenerate the source speech (Windows only)

Windows PowerShell 5.1, System.Speech and enabled Microsoft Huihui Desktop zh-CN voice are required. Enumeration is not proof the voice engine can synthesize under a restricted token. On this host synthesis required the normal approved sandbox escalation to access local SAPI; the denied/restricted run failed in `SAPICategories.DefaultDeviceOut()` without network access. Do not silently change voice or fall back to a tone.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/fixtures/regenerate-mvp-speech.ps1 -OutputDirectory projects/new-speech-source
```

This creates a fresh directory with WAV, canonical text and provenance; it refuses an existing directory. Review and probe new output, then explicitly replace only those three fixture source files before rebuilding into a new project. Rate 1 was experimentally 121868 ms and rejected by the acceptance duration boundary; rate 2 produced 109040 ms, without padding, time stretching or text edits. Different OS/voice versions may differ; recheck 60–120 seconds, byte hashes and listening. macOS/Linux can replay the preserved source but cannot regenerate this particular Windows voice; use a Windows host for an equivalent source. Do not relabel another engine as Huihui.

## What COMPLETE does not mean

Automated checks establish approvals, canonical TTS input, immutable voice/media identity, zero-cost settlement, PCM 48 kHz, H.264/AAC, 1080×1920 at 30 fps, runtime and clean technical QC. No ASR/transcription or word-level provider alignment is performed. The speech source has no word timings, so the existing caption planner uses its documented proportional timing fallback; exact lip/word synchronization requires listening review. Integrated loudness is unavailable from the current probe and is not a loudness pass. No publishing, commercial rights clearance, paid-provider test, human voice claim or cloned voice claim is implied.
