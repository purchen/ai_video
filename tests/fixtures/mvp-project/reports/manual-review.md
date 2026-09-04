# Manual inspection record — 2026-09-04

## Final-fix regeneration note

The observations quoted below concern the pre-final-fix chain. The revised chain was rebuilt from the same narration and original Huihui source WAV, with explicit lens/analysis metadata and measured QC, rather than patched hashes. No new full-motion or listening review was performed. New measured narration is −23.87 LUFS / −0.71 dBTP; final mix is −23.89 LUFS / −3.75 dBTP; neither has a detected ≥2-second silence below −50 dB. The historical sentence “Probe loudness is null” below describes the older check only. Human intelligibility, exact spoken words and caption timing remain REQUIRED.

Scope: a local test sample, not editorial approval for publication. Narration is Windows built-in synthetic speech; examples and source records are original fictional test data. Automated `offline-fixture-editor` approvals exercise real approval mechanics but do not assert an actual human approved a production story.

## Controller observations (reported verbatim)

> Controller actual QA: read narration.txt and viewed beginning/middle/end PNGs at supplied run-aVzaDc. All three1080×1920 frames have readable Chinese text/captions, no observed clipping or overlap, opening visibly says原创思考测试样片/系统合成/完全虚构. Middle/end opinion wording appropriately marked original interpretation, no real-person claims. Caption segmentation is coarse and strips punctuation; no word-level sync/listening/ASR/full-motion QA performed, do NOT claim those passed. I will expose MP4/WAV for user review but cannot truthfully claim human-equivalent audio listening.

Those frames came from the first real E2E run under `projects/mvp-e2e/run-aVzaDc/mvp-project`, using the identical locked text, preserved speech bytes, source metadata and renderer. The canonical `tests/fixtures/mvp-project` was independently run through the same pipeline and has its own immutable approval/voice IDs; the three controller observations were on the first run, not a claim to have separately watched the canonical entire movie.

## Implementer source-card inspection

Viewed canonical `reports/source-card.png`, extracted from the final MP4 at 23 seconds. It visibly reads `合成测试数据：两晚的原创虚构日记` and publisher `合成测试数据（非新闻）`, with `采集 2026-09-04（发布日期未提供）`. Chinese glyphs and caption are readable; no clipping or overlap observed in this frame. This checks the actual rendered synthetic labels, not just JSON fields. Beginning/middle/end extractions are at 3.000, 54.520 and 106.040 seconds.

Controller additionally viewed this canonical source frame and reported: “已查看canonical source-card.png：标题明确‘合成测试数据：两晚的原创虚构日记’、publisher‘合成测试数据（非新闻）’，采集日期与未提供发布日期明确区分；来源卡/字幕可读、未见裁切重叠。Controller还fresh运行status --project tests/fixtures/mvp-project，exit0 COMPLETE/diagnostics[]/产物路径。”

## Automated evidence and explicit non-checks

The official readers and actual probe establish matching approval/script hashes, committed synthetic voice, 48 kHz PCM master, H.264/AAC 1080×1920 at 30 fps, 109.04-second voice, 109.066667-second video stream and 109.12-second MP4 container, zero-cost settlement and QC_PASSED with no errors. This is media plumbing and input integrity evidence, not proof of accurate spoken content.

No human-equivalent audio listening, ASR/transcription, phoneme/word accuracy, precise subtitle synchronization, complete-motion viewing, subjective loudness judgment or commercial rights clearance was performed. The built-in speech does not provide word timings here; the existing caption planner uses proportional fallback, and punctuation is omitted by its caption segmentation. Probe loudness is null. Do not describe those absent checks as passes. The MP4 and WAV remain available for the user to listen and review. No paid service, cloning, live factual research, platform upload or publication occurred.
