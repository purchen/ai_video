# Local vertical renderer

Install locked dependencies with `npm ci`. Provision the browser once, with normal network/download approval, using `npm run render:provision`. Remotion keeps the browser under the nearest package root's `node_modules/.remotion` (run provisioning from this worktree). Rendering itself refuses to download a missing browser and consumes only staged local files.

`npm run render -- <projectRoot>` reads formal script approval, probes the committed immutable voice transaction, validates `edit-plan.json` against both production hashes and re-derived approved content, then renders H.264/AAC at 1080×1920, 30 fps. Only a successfully probed `output/final.partial.mp4` is renamed to `output/final.mp4`. A failed retry preserves a previous final, which is not evidence of the new attempt succeeding. Task9 must provide a project lock; concurrent rendering of the same project is unsupported.

`npm run remotion:preview` opens the template shell, not an approval bypass. Production input loading is through the render command.

## Managed tools and direct TTS

`resolveManagedMediaTools()` resolves explicit platform binaries through the pinned Remotion 4.0.520 renderer. It exposes FFmpeg, ffprobe, `probe`, and `converter` for Task9/10; it never searches PATH. `generateManagedVoice()` wires those adapters into Task6. `generateVoice()` accepts an optional explicit `AudioConverter`: only non-48k/non-PCM/non-WAV output is converted to a separate transaction-local temporary file, re-probed, then committed. Compliant bytes are not re-encoded. Without a converter the strict format rejection remains. Locked narration, cost settlement, and attempt recovery rules are unchanged.

Remotion's reduced FFmpeg supports the tested PCM WAV resampling, PNG decoding/encoding, H.264 and AAC operations; it does **not** provide the rawvideo demuxer. Do not infer full system FFmpeg feature coverage.

The default workflow now resolves both probe and converter when omitted, including direct provider WAV output at other sample rates. Managed probing also records measured integrated LUFS. Lower-level explicitly injected probes can still report unknown loudness; production QC never interprets unknown as a pass.

## Measured production audio QC

Production QC checks actual final media duration (inclusive 60–120 seconds), narration master and final mix. The pinned binary supplies `loudnorm` **input** LUFS/true peak and `silencedetect`; no normalized output is substituted into the project. Measurements are retained in `reports/qc.json`. Near-full-scale true peak (at least −0.1 dBTP), unmeasurable/silent audio, integrated loudness below −45 LUFS, or a ≥2-second segment below −50 dB fails with an actionable error. These conservative thresholds detect technical hazards, not every historical distortion or subjective problem.

When music is selected, QC measures its effective stem using the actual gain, loop and full narration duration, then requires its integrated loudness to be at least 16 dB below narration. An insufficient ratio requires lower music gain/re-export or removal; a raw −16 dB gain alone does not establish that ratio. No automatic mixer is added. Integrated measurements do not guarantee every instant's masking behavior: human listening remains mandatory.

Every report explicitly includes `manualChecks: intelligibility / REQUIRED`. Technical `QC_PASSED`/`COMPLETE` does not claim listening, exact spoken words, word-level synchronization or publication approval. No ASR is used. The six-second renderer smoke remains separate and is not eligible for production QC. Ordinary tests serialize files, use 30-second bounded integration timeouts, and retain the existing 180/300-second explicit real-render bounds.

## Media and layout contract

All selected media and permission/generation references must exist inside the project after resolving symlinks/junctions. Authorized clips support local MP4/WebM/MOV. The single video stream itself must cover the scene duration, using stream `duration` or `duration_ts × time_base`; unknown duration or multiple video streams are rejected. A longer audio/container duration never supplies missing visual coverage. Clip audio is muted. AI-abstract visuals support local static PNG/JPEG/WebP; animated PNG/WebP is rejected. Ambient music supports local WAV/MP3/M4A, loops, and uses the plan's gain of at most −16 dB. Unsupported formats fail before rendering, rather than being omitted. Permission/provenance records remain bound to their selected asset IDs.

Source cards show the unchanged title, publisher, and publication date; absent publication dates are explicitly labeled with the capture date. Public-question labels are scene-level and appear independently of visual selection. Captions use Task7 cues and stay 320 px above the bottom, with additional right-side clearance. This template explicitly rejects kinetic text over 90 code points, more than two source cards, source titles over 70 code points, or publishers over 40; those require reviewed layout changes rather than clipping.

Chinese text uses the locally bundled, exact-version `@fontsource/noto-sans-sc@5.3.0` font. Its font software is licensed under SIL Open Font License 1.1 (full license in `node_modules/@fontsource/noto-sans-sc/LICENSE`); no OS/proprietary font is copied. The browser waits for the local font before rendering. Remotion has its own licensing terms; see the upstream package and official site for applicable use terms.

## Tests

`npm test -- tests/render` includes a real offline six-second render. It uses an original procedural image/clip and sine-wave test audio, including a local response fixture passed through the real OpenAI adapter and managed 24k→48k conversion. No paid request or remote asset is used. These are **test fixtures, not narration, factual evidence, or final MVP acceptance**. Artifacts remain in ignored `projects/render-smoke/run-*/topic-001/output` for inspection. Task10 retains full production duration and audio/content QC responsibilities.

References: [managed FFmpeg](https://www.remotion.dev/docs/cli/ffmpeg), [ffprobe](https://www.remotion.dev/docs/cli/ffprobe), [browser provisioning](https://www.remotion.dev/docs/renderer/ensure-browser), [render API](https://www.remotion.dev/docs/renderer/render-media).
