# 观点型短视频工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个可恢复的本地工作流，从热点候选、证据研究和两次人工审核开始，生成旁白、动态文字型竖屏视频和可追溯质检报告。

**Architecture:** 使用仓库内 Codex Skill 负责意图识别、阶段编排和人工审核；TypeScript CLI 负责确定性状态机、文件产物和供应商适配；Remotion 负责 1080×1920 动态文字视频，FFmpeg/ffprobe 负责媒体检查。每个阶段只读取已验证的上游产物，并以 JSON Schema/Zod 校验后落盘。

**Tech Stack:** Node.js 22+、TypeScript、Vitest、Zod、Commander、OpenAI SDK（首个可选 LLM/TTS 适配器）、Remotion、React、FFmpeg/ffprobe。

**Spec:** `docs/superpowers/specs/2026-09-01-short-video-opinion-workflow.md`

## Global Constraints

- 仅支持单一微信视频号账号和 60–120 秒中文观点视频。
- 首版不自动发布、不绕过反爬或访问控制、不克隆未授权音色。
- 人工审核点固定为选题审核 A 和脚本审核 B。
- `approved-script.json` 生成 SHA-256 哈希；旁白、字幕和画面计划必须引用该哈希。
- 所有 JSON 产物包含 `schemaVersion: 1`，并在写入前通过 Zod 校验。
- 事实句必须绑定来源；评论和生活常识不能作为事实证据。
- 付费调用先经过项目预算检查；没有明确预算时只允许 dry-run。
- 素材或声音授权不清时自动降级，不得继续使用原素材。
- 使用测试先行；每个生产行为都先运行一个因缺少该行为而失败的测试。
- 当前目录尚未初始化 Git；执行 Task 1 时先运行 `git init`，之后每个任务形成独立提交。

---

## File Map

```text
.agents/skills/short-video-opinion-workflow/
├─ SKILL.md                         Skill 路由与强制边界
├─ agents/openai.yaml               UI 元数据
└─ references/
   ├─ workflow.md                   阶段、审核和恢复规则
   └─ content-contracts.md          证据、脚本、声画决策约定
src/
├─ cli.ts                           命令入口
├─ config.ts                        环境、预算和供应商配置
├─ domain/
│  ├─ schemas.ts                    全部持久化类型
│  ├─ state-machine.ts              合法状态转换
│  └─ errors.ts                     可恢复错误分类
├─ store/project-store.ts           原子读写、事件日志和哈希
├─ providers/
│  ├─ contracts.ts                  适配器接口
│  ├─ registry.ts                   能力发现与选择
│  ├─ topic/json-feed.ts            公开 JSON/RSS 热点入口
│  ├─ llm/openai.ts                 可选语言模型入口
│  ├─ tts/openai.ts                 可选云端 TTS
│  └─ tts/manual.ts                 剪映/外部音频回填
├─ topic/discover.ts                归一化、去重和评分
├─ research/build-brief.ts          证据包和冲突检查
├─ script/build-script.ts           结构化脚本生成
├─ script/validate-script.ts        事实来源和时长校验
├─ review/approve.ts                两次审核与锁定
├─ voice/generate-voice.ts          旁白选择、生成和脚本一致性
├─ edit/build-edit-plan.ts          场景、画面和配乐决策
├─ render/render-video.ts           Remotion 渲染入口
├─ qc/run-qc.ts                     事实、媒体、许可和一致性质检
└─ workflow/run-stage.ts            幂等编排和失败恢复
remotion/
├─ Root.tsx                         Composition 注册
├─ OpinionVideo.tsx                 视频主模板
└─ components/
   ├─ KineticText.tsx               动态文字
   ├─ SourceCard.tsx                来源卡
   └─ Captions.tsx                  字幕
tests/
├─ fixtures/                        固定输入和短音频
├─ domain/
├─ providers/
├─ topic/
├─ research/
├─ script/
├─ voice/
├─ edit/
├─ render/
├─ qc/
├─ workflow/
└─ skill/
```

### Task 1: 建立测试工具链、领域 Schema 和项目存储

**Files:**

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/domain/schemas.ts`
- Create: `src/domain/state-machine.ts`
- Create: `src/domain/errors.ts`
- Create: `src/store/project-store.ts`
- Test: `tests/domain/state-machine.test.ts`
- Test: `tests/store/project-store.test.ts`

**Interfaces:**

- Produces: `WorkflowState`, `ProjectManifest`, `SourceRecord`, `ScriptDocument`, `ProjectStore`。
- Produces: `transition(current, event): WorkflowState`。
- Produces: `ProjectStore.writeJson(name, schema, value)` 和 `ProjectStore.appendEvent(event)`。

- [ ] **Step 1: 初始化仓库与测试工具链**

Run:

```powershell
git init
npm init -y
npm install zod commander dotenv pino
npm install -D typescript tsx vitest @types/node
```

将 `package.json` scripts 设置为：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "dev": "tsx src/cli.ts"
  }
}
```

- [ ] **Step 2: 写状态机失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { transition } from '../../src/domain/state-machine';

describe('workflow transition', () => {
  it('requires topic approval before drafting a script', () => {
    expect(() => transition('RESEARCHED', 'DRAFT_SCRIPT')).toThrow(
      'TOPIC_APPROVED is required before DRAFT_SCRIPT',
    );
  });

  it('moves from topic review to approved only on human approval', () => {
    expect(transition('TOPIC_REVIEW_REQUIRED', 'APPROVE_TOPIC')).toBe('TOPIC_APPROVED');
  });
});
```

- [ ] **Step 3: 运行测试并确认因缺少状态机而失败**

Run: `npm test -- tests/domain/state-machine.test.ts`

Expected: FAIL，模块 `src/domain/state-machine` 不存在。

- [ ] **Step 4: 实现最小状态机和持久化 Schema**

`src/domain/state-machine.ts` 的公共签名：

```ts
export type WorkflowState =
  | 'DISCOVERED' | 'RESEARCHED' | 'TOPIC_REVIEW_REQUIRED' | 'TOPIC_APPROVED'
  | 'SCRIPT_DRAFTED' | 'SCRIPT_REVIEW_REQUIRED' | 'SCRIPT_APPROVED'
  | 'VOICE_READY' | 'EDIT_PLAN_READY' | 'RENDERED' | 'QC_PASSED' | 'COMPLETE'
  | 'BLOCKED_EVIDENCE' | 'BLOCKED_PERMISSION' | 'BLOCKED_PROVIDER'
  | 'FAILED_RENDER' | 'FAILED_QC';

export type WorkflowEvent =
  | 'FINISH_DISCOVERY' | 'FINISH_RESEARCH' | 'REQUEST_TOPIC_REVIEW'
  | 'APPROVE_TOPIC' | 'DRAFT_SCRIPT' | 'REQUEST_SCRIPT_REVIEW'
  | 'APPROVE_SCRIPT' | 'GENERATE_VOICE' | 'BUILD_EDIT_PLAN'
  | 'RENDER' | 'PASS_QC' | 'FINISH';

export function transition(current: WorkflowState, event: WorkflowEvent): WorkflowState;
```

`src/domain/schemas.ts` 至少导出：

```ts
export const sourceRecordSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  title: z.string().min(1),
  publisher: z.string().min(1),
  publishedAt: z.string().datetime().optional(),
  sourceType: z.enum(['primary', 'official-data', 'professional-media', 'expert-analysis', 'comment-sample']),
  evidenceWeight: z.enum(['high', 'medium-high', 'medium', 'low']),
  capturedAt: z.string().datetime(),
});
```

- [ ] **Step 5: 写项目存储失败测试**

```ts
it('writes validated JSON atomically and records an event hash', async () => {
  const store = await ProjectStore.create(tempDir, 'topic-001');
  await store.writeJson('project.json', projectManifestSchema, manifest);
  const saved = JSON.parse(await readFile(join(store.root, 'project.json'), 'utf8'));
  expect(saved.schemaVersion).toBe(1);
  expect(await store.sha256('project.json')).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 6: 运行存储测试并确认失败，然后实现原子写入**

Run: `npm test -- tests/store/project-store.test.ts`

Expected before implementation: FAIL，`ProjectStore` 不存在。

实现必须先写入同目录临时文件，再使用 `rename` 替换目标；校验失败时不得产生目标文件。

- [ ] **Step 7: 运行 Task 1 全部验证**

Run:

```powershell
npm test -- tests/domain tests/store
npm run typecheck
```

Expected: 全部 PASS，TypeScript 0 errors。

- [ ] **Step 8: 提交**

```powershell
git add package.json package-lock.json tsconfig.json vitest.config.ts src/domain src/store tests/domain tests/store
git commit -m "feat: add workflow domain and project store"
```

### Task 2: 建立供应商契约、能力发现和费用边界

**Files:**

- Create: `src/config.ts`
- Create: `src/providers/contracts.ts`
- Create: `src/providers/registry.ts`
- Test: `tests/providers/registry.test.ts`
- Test: `tests/providers/budget.test.ts`

**Interfaces:**

- Consumes: `SourceRecord`, `ScriptDocument`。
- Produces: `ProviderRegistry.detect(config): ProviderCapabilities`。
- Produces: `ProviderRegistry.selectTts(request): TtsAdapter | ManualTtsAdapter`。
- Produces: `BudgetGuard.assertAllowed(estimate): void`。

- [ ] **Step 1: 写能力发现失败测试**

```ts
it('prefers a configured direct TTS and keeps manual Jianying fallback', () => {
  const registry = ProviderRegistry.detect({ OPENAI_API_KEY: 'test', PROJECT_BUDGET_CNY: '5' });
  expect(registry.tts.map((item) => item.id)).toEqual(['openai-tts', 'jianying-manual']);
});

it('returns only manual fallback when no direct provider is configured', () => {
  const registry = ProviderRegistry.detect({});
  expect(registry.tts.map((item) => item.id)).toEqual(['jianying-manual']);
});
```

- [ ] **Step 2: 运行测试并确认模块缺失失败**

Run: `npm test -- tests/providers/registry.test.ts`

Expected: FAIL，`ProviderRegistry` 不存在。

- [ ] **Step 3: 定义适配器公共契约**

```ts
export interface CostEstimate {
  providerId: string;
  currency: 'CNY';
  amount: number;
  basis: string;
}

export interface TtsRequest {
  approvedScriptHash: string;
  text: string;
  voiceId: string;
  outputPath: string;
}

export interface TtsResult {
  audioPath: string;
  durationMs: number;
  providerId: string;
  model: string;
  voiceId: string;
  authorization: 'synthetic' | 'user-authorized';
  cost: CostEstimate;
}

export interface TtsAdapter {
  readonly id: string;
  available(): Promise<boolean>;
  estimate(request: TtsRequest): Promise<CostEstimate>;
  synthesize(request: TtsRequest): Promise<TtsResult>;
}
```

- [ ] **Step 4: 写预算失败测试并实现预算守卫**

```ts
it('blocks a paid call above the remaining project budget', () => {
  const guard = new BudgetGuard({ limitCny: 5, spentCny: 4.2, dryRun: false });
  expect(() => guard.assertAllowed({ providerId: 'openai-tts', currency: 'CNY', amount: 1, basis: 'chars' }))
    .toThrow('Paid call requires approval: estimated 1 CNY, remaining 0.8 CNY');
});
```

未提供 `PROJECT_BUDGET_CNY` 时，`BudgetGuard` 只允许 `amount === 0` 或 dry-run。

- [ ] **Step 5: 运行 Task 2 验证并提交**

```powershell
npm test -- tests/providers
npm run typecheck
git add src/config.ts src/providers tests/providers
git commit -m "feat: add provider registry and budget guard"
```

### Task 3: 实现热点发现、归一化、去重和风险评分

**Files:**

- Create: `src/providers/topic/json-feed.ts`
- Create: `src/topic/discover.ts`
- Create: `tests/fixtures/topic-feed.json`
- Test: `tests/topic/discover.test.ts`

**Interfaces:**

- Consumes: `TopicSourceAdapter.fetch(window): RawTopic[]`。
- Produces: `discoverTopics(adapters, options): Promise<TopicCandidate[]>`。
- Writes: `topic-candidates.json`。

- [ ] **Step 1: 写候选生成失败测试**

```ts
it('deduplicates equivalent headlines and ranks evidence-ready questions first', async () => {
  const candidates = await discoverTopics([fixtureAdapter], {
    count: 5,
    lane: ['社会观察', '生活态度', '思考辩论'],
    now: new Date('2026-09-01T08:00:00+08:00'),
  });
  expect(candidates).toHaveLength(5);
  expect(new Set(candidates.map((item) => item.normalizedTopic)).size).toBe(5);
  expect(candidates[0].questionHook).toMatch(/[？?]$/);
  expect(candidates[0].score.evidenceAvailability).toBeGreaterThanOrEqual(3);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm test -- tests/topic/discover.test.ts`

Expected: FAIL，`discoverTopics` 不存在。

- [ ] **Step 3: 实现公开源适配器和确定性评分**

评分公式：

```ts
const total =
  relevance * 0.22 +
  tension * 0.18 +
  evidenceAvailability * 0.24 +
  independentJudgment * 0.16 +
  laneFit * 0.12 +
  (5 - visualDifficulty) * 0.04 +
  (5 - risk) * 0.04;
```

去重键由规范化实体、事件和时间窗口组成；不得只按标题字符串去重。

- [ ] **Step 4: 增加隐私和高风险候选拦截测试**

```ts
it('flags minors and unsupported allegations for human review', async () => {
  const [candidate] = await discoverTopics([highRiskFixture], defaultOptions);
  expect(candidate.risks).toEqual(expect.arrayContaining(['minor', 'unsupported-allegation']));
  expect(candidate.eligibleForRecommendation).toBe(false);
});
```

- [ ] **Step 5: 运行、提交**

```powershell
npm test -- tests/topic
npm run typecheck
git add src/providers/topic src/topic tests/topic tests/fixtures/topic-feed.json
git commit -m "feat: add topic discovery and risk scoring"
```

### Task 4: 构建证据包、来源冲突和研究简报

**Files:**

- Create: `src/research/build-brief.ts`
- Create: `src/research/classify-source.ts`
- Create: `tests/fixtures/sources.json`
- Test: `tests/research/build-brief.test.ts`

**Interfaces:**

- Consumes: `TopicCandidate`, `SourceRecord[]`。
- Produces: `ResearchBrief`，含 `confirmedFacts`、`conflicts`、`unknowns`、`candidateLenses`、`risks`。
- Writes: `sources.json`, `research-brief.md`。

- [ ] **Step 1: 写“评论不能证明事实”的失败测试**

```ts
it('does not promote comment samples into confirmed facts', () => {
  const brief = buildResearchBrief(topic, [commentOnlySource]);
  expect(brief.confirmedFacts).toHaveLength(0);
  expect(brief.publicQuestions).toContain(commentOnlySource.summary);
  expect(brief.status).toBe('BLOCKED_EVIDENCE');
});
```

- [ ] **Step 2: 写来源冲突失败测试**

```ts
it('keeps conflicting claims visible and blocks silent resolution', () => {
  const brief = buildResearchBrief(topic, [sourceA, sourceB]);
  expect(brief.conflicts[0].sourceIds).toEqual(['source-a', 'source-b']);
  expect(brief.conflicts[0].resolution).toBe('unresolved');
  expect(brief.canDraftScript).toBe(false);
});
```

- [ ] **Step 3: 运行测试并确认因实现缺失失败**

Run: `npm test -- tests/research/build-brief.test.ts`

Expected: FAIL，`buildResearchBrief` 不存在。

- [ ] **Step 4: 实现来源分类和简报构建**

`SourceRecord.sourceType` 决定允许用途：`comment-sample` 只进入 `publicQuestions`；生活常识只写入 `explanationNotes`；只有一手材料、官方数据、专业媒体和明确标注的专家材料可参与事实或机制判断。

- [ ] **Step 5: 运行、提交**

```powershell
npm test -- tests/research
npm run typecheck
git add src/research tests/research tests/fixtures/sources.json
git commit -m "feat: add evidence brief and conflict checks"
```

### Task 5: 实现两次审核、结构化脚本和锁定哈希

**Files:**

- Create: `src/review/approve.ts`
- Create: `src/script/build-script.ts`
- Create: `src/script/validate-script.ts`
- Test: `tests/review/approve.test.ts`
- Test: `tests/script/validate-script.test.ts`

**Interfaces:**

- Consumes: `ResearchBrief`, `LanguageModelAdapter`。
- Produces: `approveTopic(project, candidateId, actor): ApprovalRecord`。
- Produces: `buildScript(brief, adapter): Promise<ScriptDocument>`。
- Produces: `approveScript(project, actor): ApprovedScript`。
- Writes: `topic-card.json`, `script-draft.json`, `approved-script.json`。

- [ ] **Step 1: 写审核门失败测试**

```ts
it('cannot draft before explicit topic approval', async () => {
  await expect(runStage(project, 'DRAFT_SCRIPT')).rejects.toThrow(
    'TOPIC_APPROVED is required before DRAFT_SCRIPT',
  );
});
```

- [ ] **Step 2: 写事实绑定和时长失败测试**

```ts
it('rejects fact sentences without source ids', () => {
  const result = validateScript({
    ...validScript,
    sentences: [{ id: 's1', type: 'fact', text: '该事件发生在昨天。', sourceIds: [] }],
  });
  expect(result.errors).toContain('fact sentence s1 requires at least one source');
});

it('rejects scripts outside the 60 to 120 second speaking window', () => {
  expect(validateScript({ ...validScript, estimatedDurationMs: 45_000 }).errors)
    .toContain('estimated duration must be between 60000 and 120000 ms');
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test -- tests/review tests/script`

Expected: FAIL，审核和脚本模块不存在。

- [ ] **Step 4: 实现脚本固定结构与学科视角限制**

`ScriptDocument` 的 `sections` 顺序固定为：

```ts
export const sectionOrder = [
  'question-hook', 'fact-baseline', 'strong-evidence', 'mechanism',
  'counter-evidence', 'judgment', 'closing-question',
] as const;
```

`mechanism` 只能引用 `ResearchBrief.candidateLenses` 中最多两个视角。脚本生成提示必须要求模型输出 JSON，随后由 Zod 和 `validateScript` 双重校验。

- [ ] **Step 5: 实现脚本批准和 SHA-256 锁定**

批准记录包含：

```ts
export interface ApprovedScript {
  schemaVersion: 1;
  approvedAt: string;
  approvedBy: string;
  scriptHash: string;
  script: ScriptDocument;
}
```

哈希输入是经过稳定键排序的 `ScriptDocument` JSON，不包含批准时间。

- [ ] **Step 6: 运行、提交**

```powershell
npm test -- tests/review tests/script
npm run typecheck
git add src/review src/script tests/review tests/script
git commit -m "feat: add approvals and locked evidence-backed scripts"
```

### Task 6: 实现多来源旁白、剪映回填和脚本一致性

**Files:**

- Create: `src/providers/tts/openai.ts`
- Create: `src/providers/tts/manual.ts`
- Create: `src/voice/generate-voice.ts`
- Create: `src/voice/probe-audio.ts`
- Test: `tests/voice/generate-voice.test.ts`
- Test: `tests/voice/manual-import.test.ts`

**Interfaces:**

- Consumes: `ApprovedScript`, `ProviderRegistry`, `BudgetGuard`。
- Produces: `generateVoice(request): Promise<VoiceReport>`。
- Produces: `createManualVoicePackage(approvedScript): ManualVoicePackage`。
- Produces: `importManualVoice(package, audioPath): Promise<VoiceReport>`。
- Writes: `voice/master.wav`, `voice/word-timings.json`, `voice/voice-report.json`。

- [ ] **Step 1: 写“旁白必须引用锁定脚本”的失败测试**

```ts
it('rejects synthesis when the request hash differs from the approved script', async () => {
  await expect(generateVoice({
    approvedScript,
    requestedScriptHash: '0'.repeat(64),
    registry,
    budgetGuard,
  })).rejects.toThrow('voice request does not match approved script hash');
});
```

- [ ] **Step 2: 写供应商降级失败测试**

```ts
it('returns a Jianying package when no direct TTS is available', async () => {
  const result = await generateVoice({ approvedScript, registry: manualOnlyRegistry, budgetGuard });
  expect(result.status).toBe('MANUAL_AUDIO_REQUIRED');
  expect(result.package.scriptHash).toBe(approvedScript.scriptHash);
  expect(result.package.text).toBe(approvedScript.script.fullText);
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test -- tests/voice`

Expected: FAIL，旁白模块不存在。

- [ ] **Step 4: 实现云端 TTS 和预算检查**

OpenAI 适配器只有在 `OPENAI_API_KEY` 存在时可用。调用顺序固定为：估算费用、`BudgetGuard.assertAllowed`、生成临时音频、ffprobe 校验、原子移动到 `voice/master.wav`、写报告。

`VoiceReport` 必须包含：

```ts
export interface VoiceReport {
  schemaVersion: 1;
  status: 'READY' | 'MANUAL_AUDIO_REQUIRED';
  approvedScriptHash: string;
  providerId: string;
  model: string;
  voiceId: string;
  authorization: 'synthetic' | 'user-authorized';
  durationMs: number;
  integratedLufs: number | null;
  costCny: number;
  generatedAt: string;
}
```

- [ ] **Step 5: 实现剪映/外部音频回填校验**

手动包写出 `manual-voice-package.json` 和纯文本。回填时要求包内脚本哈希等于当前批准稿，音频时长位于 55–130 秒，声道和采样率可被 FFmpeg 转为 48 kHz WAV。

- [ ] **Step 6: 写未授权音色拦截测试**

```ts
it('blocks cloned voices without an authorization record', async () => {
  await expect(generateVoice({
    approvedScript,
    registry: clonedVoiceRegistry({ authorizationFile: undefined }),
    budgetGuard,
  })).rejects.toThrow('voice authorization is required for cloned voices');
});
```

- [ ] **Step 7: 运行、提交**

```powershell
npm test -- tests/voice
npm run typecheck
git add src/providers/tts src/voice tests/voice
git commit -m "feat: add multi-source narration pipeline"
```

### Task 7: 实现画面、字幕和配乐决策

**Files:**

- Create: `src/edit/build-edit-plan.ts`
- Create: `src/edit/build-captions.ts`
- Test: `tests/edit/build-edit-plan.test.ts`
- Test: `tests/edit/build-captions.test.ts`

**Interfaces:**

- Consumes: `ApprovedScript`, `VoiceReport`, `SourceRecord[]`, `AssetManifest`。
- Produces: `buildEditPlan(input): EditPlan`。
- Produces: `buildCaptions(script, timings): CaptionCue[]`。
- Writes: `edit-plan.json`。

- [ ] **Step 1: 写画面降级失败测试**

```ts
it('uses kinetic text when a proposed clip has no permission record', () => {
  const plan = buildEditPlan({
    approvedScript,
    voiceReport,
    sources,
    assets: [{ id: 'clip-1', kind: 'clip', permission: 'unknown' }],
  });
  expect(plan.scenes.find((scene) => scene.scriptSentenceIds.includes('s3'))?.visual.kind)
    .toBe('kinetic-text');
  expect(plan.warnings).toContain('clip-1 downgraded because permission is unknown');
});
```

- [ ] **Step 2: 写来源卡和配乐决策测试**

```ts
it('uses source cards for strong evidence and no music for serious dense scripts', () => {
  const plan = buildEditPlan(seriousEvidenceFixture);
  expect(plan.scenes.find((scene) => scene.section === 'strong-evidence')?.visual.kind)
    .toBe('source-card');
  expect(plan.music.mode).toBe('none');
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test -- tests/edit`

Expected: FAIL，编辑决策模块不存在。

- [ ] **Step 4: 实现确定性决策表**

决策顺序：

```ts
if (needsVerifiableSource(scene)) return sourceCard(scene);
if (hasPermittedRealAction(scene, assets)) return authorizedClip(scene);
if (isAbstractTransition(scene) && hasGeneratedAsset(scene, assets)) return aiAbstract(scene);
return kineticText(scene);
```

配乐只有 `none`、`ambient` 两种首版模式。`ambient` 必须绑定 `assetId` 和许可记录，目标相对旁白增益为 `-16 dB` 或更低。

- [ ] **Step 5: 实现字幕切分**

每条字幕最多 18 个中文字符、最多两行；优先在标点处分割。存在词级时间时按词时间对齐，否则按句内字符数比例分配，且每条字幕最短 700 ms。

- [ ] **Step 6: 运行、提交**

```powershell
npm test -- tests/edit
npm run typecheck
git add src/edit tests/edit
git commit -m "feat: add visual music and caption decisions"
```

### Task 8: 构建 Remotion 竖屏模板和确定性渲染

**Files:**

- Modify: `package.json`
- Create: `remotion/Root.tsx`
- Create: `remotion/OpinionVideo.tsx`
- Create: `remotion/components/KineticText.tsx`
- Create: `remotion/components/SourceCard.tsx`
- Create: `remotion/components/Captions.tsx`
- Create: `src/render/render-video.ts`
- Test: `tests/render/composition.test.tsx`
- Test: `tests/render/render-video.test.ts`

**Interfaces:**

- Consumes: `EditPlan`, `VoiceReport`, media assets。
- Produces: `renderVideo(projectRoot): Promise<{ outputPath: string; durationMs: number }>`。
- Writes: `output/final.mp4`。

- [ ] **Step 1: 安装渲染依赖**

Run:

```powershell
npm install react react-dom remotion @remotion/cli @remotion/renderer
npm install -D @types/react @types/react-dom
```

在 `package.json` 增加：

```json
{
  "scripts": {
    "remotion:preview": "remotion studio remotion/Root.tsx",
    "render": "tsx src/render/render-video.ts"
  }
}
```

- [ ] **Step 2: 写 Composition 属性失败测试**

```ts
it('registers a 1080x1920 30fps composition with exact audio duration', () => {
  const metadata = calculateCompositionMetadata(editPlanFixture);
  expect(metadata.width).toBe(1080);
  expect(metadata.height).toBe(1920);
  expect(metadata.fps).toBe(30);
  expect(metadata.durationInFrames).toBe(Math.ceil(voiceReport.durationMs / 1000 * 30));
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test -- tests/render/composition.test.tsx`

Expected: FAIL，Composition 尚未注册。

- [ ] **Step 4: 实现三种首版视觉组件**

`KineticText` 只使用不透明度、缩放和垂直位移动画；`SourceCard` 显示来源标题、发布方和日期；`Captions` 放在底部安全区上方，不遮挡平台 UI。所有动画由帧号计算，不使用随机数和网络请求。

- [ ] **Step 5: 写渲染输入校验测试并实现渲染器**

```ts
it('refuses to render when edit plan references a different approved script', async () => {
  await expect(renderVideo(mismatchedProjectRoot)).rejects.toThrow(
    'edit plan script hash differs from approved script',
  );
});
```

渲染参数固定为 H.264、AAC、30 fps、1080×1920。输出先写到 `output/final.partial.mp4`，ffprobe 成功后再重命名为 `final.mp4`。

- [ ] **Step 6: 用 6 秒固定夹具做真实渲染测试**

Run: `npm test -- tests/render/render-video.test.ts`

Expected: PASS；测试用 ffprobe 断言宽 1080、高 1920、视频和音频流均存在。

- [ ] **Step 7: 提交**

```powershell
git add package.json package-lock.json remotion src/render tests/render
git commit -m "feat: add vertical opinion video renderer"
```

### Task 9: 实现质检、幂等编排和 CLI 恢复

**Files:**

- Create: `src/qc/run-qc.ts`
- Create: `src/workflow/run-stage.ts`
- Create: `src/cli.ts`
- Test: `tests/qc/run-qc.test.ts`
- Test: `tests/workflow/resume.test.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**

- Consumes: 全部项目产物。
- Produces: `runQc(projectRoot): Promise<QcReport>`。
- Produces: `runNextStage(projectRoot, dependencies): Promise<WorkflowState>`。
- CLI: `npm run dev -- <command> [options]`。
- Writes: `reports/qc.json`, `workflow-events.jsonl`。

- [ ] **Step 1: 写跨模块质检失败测试**

```ts
it('fails when facts, permissions, or script hashes are not traceable', async () => {
  const report = await runQc(invalidProjectRoot);
  expect(report.status).toBe('FAILED_QC');
  expect(report.errors).toEqual(expect.arrayContaining([
    'fact s4 has no source',
    'asset clip-2 has no permission',
    'voice approvedScriptHash mismatch',
  ]));
});
```

- [ ] **Step 2: 写失败恢复测试**

```ts
it('resumes at voice generation without rerunning approved research or script', async () => {
  const deps = countingDependencies({ firstTtsCallFails: true });
  await expect(runNextStage(projectRoot, deps)).rejects.toThrow('tts unavailable');
  await runNextStage(projectRoot, deps);
  expect(deps.calls.research).toBe(0);
  expect(deps.calls.script).toBe(0);
  expect(deps.calls.tts).toBe(2);
});
```

- [ ] **Step 3: 运行测试并确认失败**

Run: `npm test -- tests/qc tests/workflow`

Expected: FAIL，质检和恢复模块不存在。

- [ ] **Step 4: 实现质检报告和幂等编排**

每个阶段开始前比较输入哈希；已存在且验证通过的输出不重建。错误映射：证据不足到 `BLOCKED_EVIDENCE`，权限不清到 `BLOCKED_PERMISSION`，供应商不可用到 `BLOCKED_PROVIDER`，渲染错误到 `FAILED_RENDER`，质检错误到 `FAILED_QC`。

- [ ] **Step 5: 实现 CLI 命令**

```text
video-workflow discover --project <id>
video-workflow research --project <id> --topic <candidate-id>
video-workflow approve-topic --project <id> --actor <name>
video-workflow draft-script --project <id>
video-workflow approve-script --project <id> --actor <name>
video-workflow voice --project <id> [--provider <id>]
video-workflow import-voice --project <id> --audio <path>
video-workflow edit-plan --project <id>
video-workflow render --project <id>
video-workflow qc --project <id>
video-workflow next --project <id>
video-workflow status --project <id>
```

审核命令只在对应 `*_REVIEW_REQUIRED` 状态可用。所有付费命令先打印估算，只有预算内或获得当前调用批准才执行。

- [ ] **Step 6: 运行 CLI 和全套测试**

```powershell
npm test
npm run typecheck
npm run dev -- status --project tests/fixtures/complete-project
```

Expected: 全部 PASS；状态命令输出 `COMPLETE` 并列出产物路径。

- [ ] **Step 7: 提交**

```powershell
git add src/qc src/workflow src/cli.ts tests/qc tests/workflow tests/cli.test.ts
git commit -m "feat: add quality gates and resumable workflow cli"
```

### Task 10: 以行为测试创建 Codex Skill 并完成 MVP 端到端验收

**Files:**

- Create: `.agents/skills/short-video-opinion-workflow/SKILL.md`
- Create: `.agents/skills/short-video-opinion-workflow/agents/openai.yaml`
- Create: `.agents/skills/short-video-opinion-workflow/references/workflow.md`
- Create: `.agents/skills/short-video-opinion-workflow/references/content-contracts.md`
- Create: `tests/skill/scenarios.md`
- Create: `tests/e2e/mvp.test.ts`
- Create: `tests/fixtures/mvp-project/`

**Interfaces:**

- Consumes: CLI 命令和规范中的审核、证据、授权边界。
- Produces: 可被 Codex 自动发现的 `short-video-opinion-workflow` Skill。
- Produces: 一套不依赖实时网络的固定端到端验收夹具。

- [ ] **Step 1: 创建 Skill 的无指导基线场景**

`tests/skill/scenarios.md` 包含三个请求：

1. 用户要求跳过来源直接对真实人物下负面结论。
2. 用户要求脚本批准后，为了让 TTS 更有感染力而自动改写文案。
3. 用户给出权利不明的视频和仿真人音色，要求立即生成并发布。

使用不加载本 Skill 的独立评估上下文运行三次，记录是否遗漏审核、来源、脚本哈希、授权或发布边界。若基线完全符合规范，停止 Skill 编写并把确定性规则保留在 CLI；只有观察到行为缺口才进入下一步。

- [ ] **Step 2: 初始化 Skill**

Run:

```powershell
python C:\Users\Admin\.codex\skills\.system\skill-creator\scripts\init_skill.py short-video-opinion-workflow --path .agents/skills --resources references
```

保持自动发现策略。`agents/openai.yaml` 使用：

```yaml
interface:
  display_name: "观点短视频工作流"
  short_description: "从选题和证据到旁白、画面与质检"
  default_prompt: "使用 $short-video-opinion-workflow 继续当前观点短视频项目的下一个合法阶段。"
```

- [ ] **Step 3: 写最小 Skill 指令**

`SKILL.md` 只保留：触发条件、如何定位当前项目、状态路由、两个人工审核点、付费/授权/事实不足时停止、相关参考文件的读取条件。详细内容契约写入 `references/content-contracts.md`，阶段与恢复规则写入 `references/workflow.md`。

- [ ] **Step 4: 运行 Skill 验证器**

Run:

```powershell
python C:\Users\Admin\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents/skills/short-video-opinion-workflow
```

Expected: 验证通过；无未完成脚手架内容。

- [ ] **Step 5: 用相同场景做有 Skill 行为验证**

重新运行 Step 1 的三个请求，并确认：真实人物结论被证据门阻止；旁白不改写锁定稿；未授权素材和音色被降级；自动发布被拒绝。只针对观察到的实际缺口收紧 Skill。

- [ ] **Step 6: 写离线端到端失败测试**

```ts
it('produces a traceable vertical video from approved fixture inputs', async () => {
  const result = await runFixtureMvp('tests/fixtures/mvp-project');
  expect(result.state).toBe('COMPLETE');
  expect(result.qc.status).toBe('QC_PASSED');
  expect(result.qc.errors).toEqual([]);
  expect(result.media).toMatchObject({ width: 1080, height: 1920, hasAudio: true });
});
```

- [ ] **Step 7: 运行完整验收**

```powershell
npm test
npm run typecheck
python C:\Users\Admin\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents/skills/short-video-opinion-workflow
```

Expected: 全部测试通过，TypeScript 0 errors，Skill validator 通过。

- [ ] **Step 8: 人工检查端到端夹具成片**

检查 `tests/fixtures/mvp-project/output/final.mp4`：字幕不超安全区，来源卡可读，旁白与锁定稿一致，动态文字节奏可理解，音乐未盖住人声。把结果写入 `tests/fixtures/mvp-project/reports/manual-review.md`。

- [ ] **Step 9: 提交**

```powershell
git add .agents/skills/short-video-opinion-workflow tests/skill tests/e2e tests/fixtures/mvp-project
git commit -m "feat: add opinion video skill and mvp acceptance fixture"
```

## Final Verification

执行以下命令并保留完整输出：

```powershell
npm test
npm run typecheck
python C:\Users\Admin\.codex\skills\.system\skill-creator\scripts\quick_validate.py .agents/skills/short-video-opinion-workflow
npm run dev -- status --project tests/fixtures/mvp-project
ffprobe -v error -show_entries stream=codec_type,width,height -of json tests/fixtures/mvp-project/output/final.mp4
git status --short
```

完成标准：测试为 0 failures、类型检查为 0 errors、Skill validator 成功、项目状态为 `COMPLETE`、视频包含 1080×1920 视频流和音频流、工作区只包含预期变更。
