# Local workflow CLI

For stage routing, editorial boundaries and the speech-bearing acceptance sample, see [workflow usage](workflow.md). The older `complete-project` below remains a tone-only technical fixture.

Use `npm run dev -- <command> --project <path-or-id>`. A bare ID resolves beneath `projects/` (override with `--projects-dir`). A relative/absolute path is resolved as a directory, never passed as a ProjectStore ID. Exit codes: **0** successful/read-only, **2** blocked or manual action, **1** failure/invalid invocation. `next` advances one stage only and stops for human review. There is no publishing command.

## Offline/manual model boundary

No live model is required. Supply explicit JSON generated or reviewed by a human/Codex; the CLI validates it and calls the real discovery/research/script modules. The CLI never invents sources or draft sentences.

```powershell
npm run dev -- discover --project projects/topic-001 --feed inputs/topics.json
npm run dev -- research --project projects/topic-001 --sources inputs/sources.json --candidate candidate-1
npm run dev -- approve-topic --project projects/topic-001 --candidate candidate-1 --actor editor
npm run dev -- draft-script --project projects/topic-001 --draft inputs/script.json
npm run dev -- approve-script --project projects/topic-001 --actor editor
npm run dev -- voice --project projects/topic-001
npm run dev -- import-voice --project projects/topic-001 --audio inputs/recording.wav --rights inputs/rights.json
npm run dev -- edit-plan --project projects/topic-001
npm run dev -- render --project projects/topic-001
npm run dev -- qc --project projects/topic-001
npm run dev -- next --project projects/topic-001
npm run dev -- status --project projects/topic-001
```

`voice` defaults to a manual narration package and exit 2. Read `voice/manual-current.json` for the immutable package ID, then `voice/manual-packages/<id>/narration.txt`. Import must use the locked approved script. `edit-plan` with no `--assets` uses source cards/kinetic text and no music. `--assets inputs/assets.json` accepts the existing AssetManifest schema; unknown-permission candidates are not selected and safely fall back to text/source cards, with warnings preserved in the plan. Render uses installed managed media tools/browser, with no auto-download; explicit provisioning is `npm run render:provision` after download approval.

Inputs:

- `topics.json`: array of `{title,url,publisher,summary?,publishedAt?}`; URLs and timestamps are validated. Candidate IDs are `candidate-1`, `candidate-2`, etc.
- `sources.json`: `{schemaVersion:1,sources:[...]}`. Each source uses SourceRecord fields and can add `claim:{key,value:"affirmed"|"denied",text}`. No claim is inferred from a title or summary. See `tests/fixtures/complete-project/sources.json` for a technical sample.
- `script.json`: ScriptDocument, matching the project manifest ID. Seven sections, evidence bindings, attribution, duration and mechanism lenses are validated. See the technical fixture's `script-draft.json`; it is a test script, not editorially approved publishing copy.
- `assets.json`: `{schemaVersion:1,projectId,assets:[]}` or permitted AssetRecord entries. Assets and permission/generation references must be project-relative local files.

## Original human recording rights

This is a distinct branch, not a cloned voice. Obtain explicit recording rights and calculate the SHA-256 of the **original input file** (e.g. `(Get-FileHash inputs/recording.wav -Algorithm SHA256).Hash.ToLower()`). Supply:

```json
{
  "schemaVersion": 1,
  "sourceKind": "original-human",
  "voiceKind": "original-human",
  "authorization": "user-authorized",
  "voiceId": "owner-recording",
  "owner": "recording owner",
  "authorizedBy": "authorized editor",
  "authorizedAt": "2026-09-04T00:00:00.000Z",
  "consentReference": "signed permission reference",
  "sourceAudioHash": "REPLACE_WITH_64_LOWERCASE_HEX_DIGITS"
}
```

The import checks the source bytes, requires 55–130 seconds after conversion, commits a 48 kHz PCM WAV, and persists immutable `authorization.json` checked by the official voice reader. Existing `jianying-synthetic`, `cloned`, and `similar-real-person` strict branches remain available; use their truthful source kind and required syntheticIdentifier/owner fields. Never label a procedural tone as a human recording.

## Paid provider policy

Default provider is manual even if the environment has a key. OpenAI is selected only with `--provider openai` or explicit config; the credential is read from `OPENAI_API_KEY`, never stored in artifacts. Example config (not a credential file):

```json
{
  "schemaVersion": 1,
  "provider": "openai",
  "budgetCny": 5,
  "dryRun": false,
  "consent": {"actor": "editor", "reference": "explicit-provider-consent"}
}
```

```powershell
npm run dev -- voice --project projects/topic-001 --config inputs/provider.json --dry-run
npm run dev -- voice --project projects/topic-001 --config inputs/provider.json
# Alternative: approval limited to this invocation, not a new project-wide budget:
npm run dev -- voice --project projects/topic-001 --provider openai --approve-cost-cny 1 --consent-by editor --consent-reference explicit-current-call-consent
```

An estimate is printed before synthesis. No budget/current-call approval means preview/manual action. `--dry-run` never calls synthesis. Durable reservation/settlement audits are hydrated under an exclusive project lock; unsettled exposure remains reserved. Consent and one-call caps are auditable in `events.jsonl`. The initial direct voice selection is the standard synthetic `alloy` voice; personalized voices can be imported with proper rights. CLI calls never automatically change to another paid attempt after ambiguous provider failure.

## Recovery and integrity

`project.json.workflowState` keeps the last successful business state so official approvals remain readable. Versioned `workflow-journal.json` records effective blocked/failed state, failed stage, manifest/artifact hashes, stable attempt ID and per-stage input hashes. `workflow-events.jsonl` is append-only, validated and hash chained. `status` and `next` expose this effective state consistently.

Retries validate the journal, event chain, current manifest and official artifact transactions first. A preflight provider failure can resume at voice without repeating research/script. A persisted completed provider result is recovered without another synthesis. Ambiguous provider-call results remain blocked under the same attempt ID and require manual provider reconciliation; there is deliberately no automatic reset/new-attempt command. Missing/mismatched journal/event pairs, changed approved artifacts and multiple pending audits require manual recovery. Do not edit journal hashes to force a retry.

`.workflow.lock` is an OS-exclusive file lock. A competing process fails fast. It is never automatically stolen: after a crash, verify the original process has stopped and no provider call remains in flight before manually removing that one lock file. Symlink/junction-managed artifact trees are rejected.

Changed upstream inputs are not silently treated as cached success. Previously approved stages are not silently rewound; create a separate project or obtain an explicit reviewed revision workflow. QC aggregates errors into `reports/qc.json`; its input hashes bind the check to the final media, official artifacts, and the bytes of every selected asset and permission/generation record. Unused unknown-permission candidates are ignored, but selected resources require matching permission and safe existing paths. Cached QC revalidates the persisted report; durable failure status includes structured artifact diagnostics without hiding the recorded failure.

## Preserved technical fixture

```powershell
npm run dev -- status --project tests/fixtures/complete-project
```

This fixture has real offline-rendered 1080×1920 H.264/AAC 30fps media and a valid approval/voice/edit/QC chain. Its audio is explicitly a procedural **tone, not speech**; COMPLETE means the technical workflow completed, not that a production narration or editorial review has been performed. `npx tsx tests/fixtures/build-complete-project.ts` builds it only when the target does not already exist. It never contacts a paid provider.
