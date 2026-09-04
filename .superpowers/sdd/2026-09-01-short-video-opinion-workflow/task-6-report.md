# Task 6 Report: Multi-source narration pipeline

## Outcome

Implemented a capability-selected narration pipeline with direct TTS, Jianying/manual fallback, external-audio import, locked-script binding, authorization checks, budget gating, explicit audio probe/conversion contracts, atomic master publication, and schema-versioned artifacts.

Commit: `df2b184aecc8443a8ee53c8c406c91134cb5dff1` (`feat: add multi-source narration pipeline`).

## TDD evidence

### RED

Command:

```powershell
npm test -- tests/voice
```

Observed before production implementation: exit code `1`; `2` test suites failed because `src/voice/generate-voice.ts` and `src/providers/tts/manual.ts` did not exist. This was the expected feature-missing failure.

### GREEN

Focused command after implementation and refactor:

```powershell
npm test -- tests/voice
```

Observed: exit code `0`; `2` files passed and `22` tests passed.

During self-review, a focused regression test also reproduced invalid actual-cost validation occurring after publication: the generate suite reported `10` passed / `1` failed. Moving provider cost validation before probe/publication produced `11/11` GREEN and ensured a non-CNY actual cost cannot leave READY artifacts.

## Provider selection rule

`ProviderRegistry` owns ordered TTS capabilities. `generateVoice` asks the registry for the first adapter whose `available()` result is true. A configured direct adapter is preferred; unavailable adapters are skipped; `jianying-manual` remains the final capability. `OpenAiTtsAdapter.available()` returns false without a non-empty API key, so no-key operation degrades to the manual package without a network call.

## Locked narration and authorization

- Direct TTS input and manual package text are derived only from `scriptNarrationText(approvedScript.script)`.
- `approvedScriptSchema` revalidates the approved script and its hash before any work.
- A mismatched `requestedScriptHash` is rejected before registry/provider calls.
- Cloned and similar-real-person voice selections require a schema-valid authorization record matching both voice ID and kind before registry, budget, or provider work.
- Built-in synthetic voices are reported as `synthetic`; imported/user-authorized audio is reported as `user-authorized`.

## Cost and publication order

For direct TTS, the enforced order is:

1. Select an available registered capability.
2. Produce an auditable local estimate.
3. Call `BudgetGuard.assertAllowed`.
4. Synthesize to a same-directory temporary WAV.
5. Probe and validate the temporary audio through the injected/explicit probe contract.
6. Validate timing and report schemas in memory.
7. Atomically rename the temporary WAV to `voice/master.wav`.
8. Atomically write `voice/word-timings.json` and `voice/voice-report.json`.
9. Record actual cost with `BudgetGuard.recordActual`.

A budget rejection therefore makes zero paid/API synthesis calls and publishes zero successful voice artifacts. Tests verify that all three successful artifacts exist when actual-cost recording occurs.

## Manual package and import

- Manual fallback writes `voice/manual-voice-package.json` (`schemaVersion: 1`) plus byte-identical `voice/manual-voice.txt`.
- Package project ID, approved hash, canonical text, and SHA-256 text hash are checked before conversion.
- Import converts to a temporary 48 kHz PCM WAV through an injected converter, probes the converted file, accepts inclusive duration bounds of 55,000 to 130,000 ms, and only then atomically replaces `master.wav`.
- Probe/conversion/validation failure removes the temporary output and does not create a new READY report or master.
- Missing word timing data is represented by the versioned `fallback-empty` envelope so Task 7 can select its fallback path.

## Audio tool readiness

The production probe/converter contract is ready when supplied explicit absolute paths to project-managed `ffprobe` and `ffmpeg` executables. It intentionally rejects PATH-only names. Binary provisioning and project configuration remain for Task 8; tests use deterministic injected fakes and never invoke global tools or live/paid APIs.

## Files

- Modified: `src/config.ts`
- Modified: `src/providers/contracts.ts`
- Modified: `src/providers/registry.ts`
- Added: `src/providers/tts/openai.ts`
- Added: `src/providers/tts/manual.ts`
- Added: `src/voice/artifacts.ts`
- Added: `src/voice/generate-voice.ts`
- Added: `src/voice/probe-audio.ts`
- Added: `src/voice/schemas.ts`
- Added: `tests/voice/fixtures.ts`
- Added: `tests/voice/generate-voice.test.ts`
- Added: `tests/voice/manual-import.test.ts`
- Added: `.superpowers/sdd/2026-09-01-short-video-opinion-workflow/task-6-report.md`

## Remaining concern

Task 8 must supply and configure the managed FFmpeg/FFprobe binaries. The OpenAI adapter is implemented without an SDK and is not exercised against the live API in this task; its network boundary is injected and all verification is offline.

## Final verification

- `npm test -- tests/voice`: exit `0`; 2 files, 22 tests passed.
- `npm test`: exit `0`; 12 files, 92 tests passed.
- `npm run typecheck`: exit `0`.
- `git diff --check`: exit `0`; only informational LF-to-CRLF working-copy warnings for three pre-existing tracked files.

---

## Independent review fix round 1

Fix commit: `34029cd5f754a08602a9a46042df259bda46b2cd` (`fix: make voice publication transactional`).

### Review disposition

All eight blocking findings were verified against commit `df2b184` and fixed in this round. Public generation/package/import entry points no longer accept an `ApprovedScript` object as authority; they begin with Task 5's `readApprovedScript(store)` durable reader.

### Round-1 RED evidence

After replacing the generation tests with the reviewed contracts:

```powershell
npm test -- tests/voice/generate-voice.test.ts
```

Observed: exit `1`; 25 tests loaded, 21 failed and 4 passed. Failures reproduced the missing durable reader, provider capability filtering, transactional readers/charges, marker failure visibility, identity binding, and audio format validation.

A later focused regression for OpenAI cost provenance failed 1/1 because the adapter basis only said `10 Unicode characters at ...`; the test required explicit `configured calculation; not provider-reported invoice` wording. Two schema/right-binding regressions also failed before their minimal fixes: charge provider mismatch was accepted, and a cloned source could be mislabeled synthetic.

### Round-1 transaction design

Authoritative READY artifacts now use an immutable versioned transaction:

```text
voice/
  transactions/<transactionId>/
    master.wav
    word-timings.json
    voice-report.json
    charge.json
  current.json                 # written last, atomically
```

`readCommittedVoice(store)` first validates the current durable approved script, then the marker, project/script/transaction bindings, all four file hashes and schemas, settled-within-authorization charge, authorization reference/hash, timing bounds, and the probed format recorded in the report. A new attempt invalidates the previous marker before provider/conversion work; incomplete immutable directories and persisted over-budget charges remain non-authoritative and invisible to the reader.

Manual packages use the same marker-last pattern:

```text
voice/
  manual-packages/<transactionId>/
    package.json
    narration.txt
  manual-current.json          # written last, atomically
```

`readManualVoicePackage(store)` validates durable approval, marker bindings, JSON hash, exact text-file byte hash, package text hash, canonical narration, and transaction/project/script identity. Manual import consumes this reader instead of a caller-supplied package.

### Round-1 budget and authorization behavior

- Estimate is validated and authorized before synthesis.
- Provider identity, voice identity/kind, authorization kind/reference/hash, actual currency, amount, provider, and audit basis are validated after synthesis.
- `BudgetGuard.settleAuthorized` records the incurred cost before publication and does not throw for a validated cost.
- `charge.json` is persisted before READY artifacts. An actual cost above authorization is recorded with `SETTLED_OVER_AUTHORIZATION`; no current marker is written.
- Direct adapters expose `supports(request)`; OpenAI supports synthetic selections only.
- Clone/similar-real-person consent records include actor, time, reference, voice ID, and kind. Reports and markers retain their reference and canonical hash.
- Manual import requires a validated source-rights record before conversion. Jianying built-ins require an explicit synthetic record; external/real-person audio requires owner consent and is reported as `user-authorized`.

### Round-1 audio and timing bindings

- `AudioMetadata` and ffprobe parsing now include `formatName` and `codecName`.
- Both direct and manual authoritative masters must prove WAV container, PCM codec, and 48 kHz sample rate.
- Reports include project ID, voice transaction ID, authorization reference/hash, format, and codec.
- Timing envelopes include project ID, approved script hash, and transaction ID; words must be monotonic, non-overlapping, and within report duration.

### Round-1 GREEN evidence

- `npm test -- tests/voice`: exit `0`; 2 files, 52 tests passed.
- `npm test`: exit `0`; 12 files, 122 tests passed.
- `npm run typecheck`: exit `0`.
- `git diff --check`: exit `0`; informational Windows line-ending warnings only.

### Round-1 remaining concern

Project-managed FFmpeg/FFprobe binary provisioning remains a Task 8 integration item. Direct OpenAI WAV output is rejected if probing does not prove 48 kHz PCM; Task 8 may inject an explicit managed conversion step if the configured provider response does not meet that contract. No live OpenAI or paid API call was made.

---

## Independent review fix round 2

Fix commit: `95c8e03` (`fix: make voice retries idempotent`).

### Round-2 RED evidence

- Initial focused review suite: `npm test -- tests/voice tests/providers/budget.test.ts` exited `1` with 24 failed / 47 passed. It reproduced missing atomic reservations, stable idempotency keys, persisted recovery audit, committed re-probe, old-marker availability, cleanup, and strict manual rights branches.
- Budget reservation TDD began with 2 failed / 7 passed before `reserve` and idempotent `settleReservation` existed.
- Self-review regressions then produced 2 expected failures for invalid/mismatched actual-cost mutation and forged `estimate=1, actual=20, WITHIN` charge semantics, followed by 2 expected failures for budget-rejection staging residue and ambiguous-provider status.

### Round-2 recovery and audit design

Each direct attempt is identified by a caller-stable UUID used as the transaction ID, budget reservation ID, and provider idempotency-key suffix. Before synthesis, the process atomically reserves the estimate in the single-process `BudgetGuard`, then persists schema-versioned reservation and attempt records under `voice/audit/<attemptId>/`. The provider boundary receives the idempotency key (including the OpenAI HTTP header).

Settlement is idempotent for the same reservation/cost and rejects conflicting re-settlement. Actual costs are validated before spent mutation. Reservation, settlement, charge, and result audits remain independent of sensitive transaction cleanup. A complete paid transaction persists its result marker in audit and becomes `RECOVERABLE` before replacing `current.json`; retry verifies/re-probes the retained immutable transaction and only republishes the marker. Any ambiguous attempt after provider invocation without a persisted result is `BLOCKED_MANUAL_RECOVERY` and cannot call the provider again.

`voiceChargeSchema` now binds reservation, transaction, project, approved hash, provider and idempotency key, records authorized maximum and remaining-budget snapshot, and independently rejects a forged within-authorization status. The guard explicitly documents its single-process concurrency boundary; Task 9's project lock is required for multi-process coordination.

### Round-2 availability, cleanup, and rights

- New direct/manual/package attempts never delete the existing current marker. Failed later attempts therefore leave the last same-script committed version readable; a durable script change naturally invalidates it in the official reader.
- Failed unpublished direct/manual transaction directories and failed manual-package directories are removed. Paid complete result transactions survive marker failure as recoverable. `cleanupVoiceArtifacts` retains current/recoverable versions plus a bounded number of recent committed versions and removes other transaction directories.
- `readCommittedVoice(store, probe)` re-probes authoritative bytes and exactly compares duration, sample rate, channels, format, and codec to the report while requiring 48 kHz PCM WAV.
- Manual source rights are a strict discriminated union: Jianying synthetic, cloned owner-authorized, and similar-real-person owner-authorized. Contradictory source/voice/authorization fields and branch-specific excess fields are rejected before conversion.

### Round-2 GREEN evidence

- `npm test -- tests/providers/budget.test.ts tests/voice/generate-voice.test.ts tests/voice/manual-import.test.ts`: exit `0`; 3 files, 73 tests passed.
- `npm test`: exit `0`; 12 files, 136 tests passed.
- `npm run typecheck`: exit `0`.
- `git diff --check`: exit `0`; informational Windows LF-to-CRLF warnings only.

### Round-2 remaining concern

Cross-process budget exclusion remains intentionally delegated to Task 9's single-project lock; persistent reservations and settlements are auditable across restart but `BudgetGuard` provides atomic concurrency only within one process. Managed FFmpeg/FFprobe provisioning remains a Task 8 integration responsibility. No live OpenAI or paid API call was made.

---

## Independent review fix round 3

Commit subject: `fix: guard voice attempt lifecycle` (based on `95c8e03`).

### Scope and root causes

Fixed only the three reviewed lifecycle findings. Concurrent direct requests previously passed the missing-audit check before either persisted its reservation; manual imports reused an existing immutable directory and removed it on failure; cleanup swallowed scan errors and relied on RECOVERABLE status even though recovery accepts an earlier status with a persisted result.

### Round-3 RED/GREEN evidence

- `npm test -- tests/voice/generate-voice.test.ts -t 'excludes concurrent'`: RED, second same-attempt caller was accepted; GREEN after lifecycle exclusion (1 passed). Barrier pauses the winner before mutable attempt persistence; the final expanded case also covers a competing manual importer and asserts one synthesis, zero competing conversions, and intact winner bytes.
- `npm test -- tests/voice/manual-import.test.ts -t 'reused manual|excludes direct'`: RED, 2 failed: the reused ID executed the failing converter, and a direct caller was accepted during manual conversion; GREEN, 2 passed after shared exclusion and pre-write reuse rejection. The repeat-import test checks the current committed audio remains readable and byte-identical.
- `npm test -- tests/voice/generate-voice.test.ts -t 'non-owned transaction'`: RED, direct synthesis overwrote an existing non-owned transaction and returned READY; GREEN, 1 passed after refusing unused-audit collisions before provider work.
- `npm test -- tests/voice/generate-voice.test.ts -t 'result-backed|fails cleanup'`: RED, 3 failed: an old-status persisted result was deleted and recovery failed, while malformed/unreadable first audits did not stop cleanup; GREEN, 3 passed after complete fail-closed audit scanning.

### Implemented boundaries

- Both generation and manual import acquire the same process-local lifecycle key before reading mutable attempt state, using filesystem `realpath` project-root canonicalization (case-normalized on Windows) plus attempt ID. The key remains held through all inner cleanup/finally work and is always released. A concurrent caller is explicitly rejected, not coalesced. This is not a cross-process lock.
- Manual import rejects any existing audit or transaction directory before mkdir/conversion, without mutating or removing it. Direct generation likewise rejects a pre-existing non-owned transaction when it has no resumable audit. Existing direct recovery remains unchanged.
- Cleanup validates every discovered audit bundle and its directory binding before destructive work. Missing required audits, malformed JSON/schema/bindings, and non-ENOENT read failures abort cleanup. Optional audit reads only treat ENOENT as absent. A persisted, bound result protects an unpublished attempt regardless of its earlier status. Already COMMITTED history continues to follow the existing bounded retention option; the current marker and audit evidence remain preserved. No new GC policy was added.

### Final verification

- `npm test -- tests/voice`: exit 0, 2 files / 71 tests passed.
- `npm test`: exit 0, 12 files / 144 tests passed.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0; informational Windows LF-to-CRLF warnings only.

No live or paid provider calls were made. No blocking concern remains for this round. Task 9 cross-process locking and Task 8 managed audio binaries remain outside this fix scope.
