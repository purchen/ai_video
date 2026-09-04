# 观点短视频 MVP：本地使用指南

这是模块化工作流，不是已安装的 Codex Skill。当前能力覆盖证据整理、两次人工审批、锁稿配音、剪辑计划、本地渲染和技术 QC；没有自动发布命令。三个无指导行为基线未展示需要新增安全 Skill 的缺口，原始请求、回答和局限保留在 [scenarios](../tests/skill/scenarios.md)。它们不证明模型在所有条件下可靠，也不替代程序校验。

## 从项目状态继续

先运行 `npm run dev -- status --project <目录>`，再按 [CLI](cli.md) 提供该阶段的本地 JSON。`next` 一次只推进一个阶段。

| 状态 | 下一项工作 |
| --- | --- |
| DISCOVERED | 提供明确主张及来源，执行 research |
| TOPIC_REVIEW_REQUIRED | 人工审查证据与选题，再显式 approve-topic |
| TOPIC_APPROVED | 提供七段式 ScriptDocument，执行 draft-script |
| SCRIPT_REVIEW_REQUIRED | 人工逐句审稿，再显式 approve-script |
| SCRIPT_APPROVED | 对锁定文本配音；默认输出手工配音包 |
| VOICE_READY / EDIT_PLAN_READY | 生成素材计划 / 使用已安装工具渲染 |
| RENDERED / QC_PASSED | 执行 QC / next 完成本地工作流 |
| BLOCKED_* / FAILED_* | 读取诊断和日志，解决原因；不得改哈希强行继续 |

两次审批均须明确编辑者身份。测试夹具中的 `offline-fixture-editor` 是自动化测试授权主体，不代表生产项目已由真人审稿。事实句需要来源和归属；评论不是事实证据，理论不能证明针对个人的结论。改动已批准文案须重新获得审阅，不能在 TTS 提交时悄悄润色。审批、声音和剪辑输入应通过正式 reader 读取，不能只信文件名或 manifest 状态。

默认不调用付费接口。确需使用时，先查看费用估计，再设置具体预算及调用同意；环境中有密钥不构成同意。不使用未知权属视频、音乐或未经同意的真人仿声。无可用授权素材时，使用来源卡与文字。COMPLETE 是本地技术工作流终态，仍需核听、逐段字幕检查、编辑复审和独立发布决定。

## 错误与重试

正式状态由 `project.json` 的上次成功业务状态与 `workflow-journal.json` 的有效状态共同表达。`workflow-events.jsonl` 保留哈希链。不要手改 journal、审批 commit 或 voice marker。明确不确定的服务调用保留同一 attempt ID，先人工对账；无自动换 ID 重试。已成功的上游输入不会被静默重写。锁文件仅在确认原进程停止且无调用在途后人工处理。完整契约见 [CLI 恢复章节](cli.md#recovery-and-integrity)。

编排 API 的 `StageDependencies.voiceId` 仅选择普通合成音色，缺省仍为 `alloy`；个性化声音继续走既有授权导入分支。真实 provider 必须支持该 ID。选择进入缓存输入及持久 attempt 绑定；同一 attempt 更换声音会拒绝且不触发新合成。此选项不是新的 CLI 音色目录，也没有新增在线 provider。

## 109 秒离线验收样片

[MVP fixture](../tests/fixtures/mvp-project/README.md) 使用原创生活态度题目“今天没做完，就算失败吗？”。来源卡显式显示“合成测试数据（非新闻）”；来源 URL 使用不可解析的 `example.invalid`，没有伪装为当前新闻。旁白是 Windows 内置中文辉辉合成语音，非真人、非克隆、非剪映、非 OpenAI 在线合成。实际文件与文本 SHA-256 均有来源记录。

```powershell
npm ci
# 仅在尚未安装浏览器时，取得下载许可后执行：
npm run render:provision
npm test -- tests/e2e/mvp.test.ts
npm run dev -- status --project tests/fixtures/mvp-project
# 独立重建到新的目录，不覆盖提交过的审批或媒体：
npx tsx tests/fixtures/build-mvp-project.ts projects/my-mvp-review
```

E2E 每次创建新项目，实际走发现、研究、两次审批停止与确认、声音交易、剪辑、109 秒 1080×1920 H.264/AAC 渲染、QC、COMPLETE；不是读取保存的 COMPLETE 冒充一次运行。环境只需已安装的锁定依赖、Remotion 浏览器及平台媒体二进制，不依赖本机中文 SAPI 音色，因为测试重放已保存的 WAV。不存在工具时应明确失败，不静默跳过。

渲染契约、字体与工具许可边界见 [rendering](rendering.md)。样片不提供商业授权结论；发布前需另行核对合成标识、音色许可与平台要求。
