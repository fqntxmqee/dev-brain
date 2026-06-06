---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
target-version: v0.11.0
---

# ai-native-os: AI Native 研发操作系统重构

## Motivation

dev-brain v0.10.0 (spec-driven-workflow) 已实现"飞书收需求 → 意图分类 → 辩论 → OpenSpec → 长程执行 → Cursor"的端到端闭环。但对照"AI Native 研发操作系统"愿景，仍有以下结构性缺口：

| 缺口 | 现象 | 业务影响 |
|------|------|---------|
| **A. 通信层黑盒** | 飞书只收最终结果，看不到 LLM 思考/工具调用过程 | 用户失去对长任务进度与意图的信任,长任务被反复催问 |
| **B. 意图路由弱** | 纯文本分类,无签名鉴权/多模态(图片/文件)/Skills 路由 | 上传截图报 bug、贴 PR 链接求 review、调用 `/opsx:propose` 都要绕弯 |
| **C. 上下文不分层** | L1 工作记忆/L2 任务记忆/L3 长期偏好混在一起,靠 InjectRules 全量塞进 system prompt | token 预算紧张,真正相关的规则被噪声淹没 |
| **D. 上下文无主动注入** | context-budget 只在溢出时被动 summarise,没有"关键节点主动 recall 相关知识" | 跨子任务传递上下文靠人工复制,长任务常丢上下文 |
| **E. Agent 状态散落** | 状态字段在 `BrainTaskPlan.subtasks[i].status` 分散管理,retry/adapter/error 三种结果都靠 if/else | 长任务状态机难调,Self-Correction 闭环无法形式化 |
| **F. 无沙箱执行** | adapter 直接 spawn 在 daemon 进程内,写错代码污染 workDir | Cursor 改坏 3 个文件,无回滚点 |
| **G. 无心跳/超时感知** | adapter 卡死只能等 `nativeTimeoutMs` (5min) 后 SIGTERM | 1 个 5min 卡死,1 个 task 白等 |
| **H. 无 Self-Correction 闭环** | retry 是"同 prompt 再试",不重读 spec,不审视错误 | 偶发错就同错再来,失败率不退化 |
| **I. 缺代码态观测** | 运行时 metric 完整,但代码质量(死代码/复杂度/重复率)无数据 | 自我进化没有"代码侧"标定,只能看运行时信号 |
| **J. 缺"僵尸代码"识别** | 旧模块 6 个月没改又没测试,Claude 还在被派去看 | token 浪费,review 噪声,核心模块被淹没 |
| **K. 缺自我进化闭环** | 失败 trace 只进 audit.log,无人/AI 复盘 | 同类错误反复犯,Prompt/Spec 永远不进化 |
| **L. 缺评测级回归** | 改了 prompt 不知道有没有退化,直接灰度 | 一次"小优化"把意图分类准确率拖崩,生产 2 天才发现 |

本 change 补齐 12 个缺口,把 dev-brain 从"AI 辅助工具"推进到"AI 自主操作系统"。

## Scope (本 change — v0.11.0+)

**Phase D — 代码态可观测 (P0, 1 周) → 给 Phase E 铺数据**

13. `src/observability/code-health/ast-analyzer.ts` — `ts-morph` 解析,产出函数列表 + 调用图
14. `src/observability/code-health/deadcode-finder.ts` — 找未被引用的 exports + class methods
15. `src/observability/code-health/complexity-reporter.ts` — `escomplex` 算圈复杂度,标 > 15 的危险函数
16. `src/observability/code-health/duplication-scanner.ts` — 调 `jscpd` 算代码重复率
17. `src/observability/code-health/zombie-detector.ts` — `git log -1` 拿最后改动时间,> 90 天且无测试覆盖的模块
18. `src/observability/code-health/snapshot.ts` — 4 项打包成 `CodeHealthSnapshot`, 写 `~/.dev-brain/code-health/<date>.json` + 上报 4 个新 metric
19. 新增 4 metric: `code.dead_exports` (gauge) / `code.complexity_p95` (gauge) / `code.duplication_pct` (gauge) / `code.zombie_files` (gauge)
20. Grafana 加 1 panel "Code Health (v0.11.0)"

**Phase E — 自我进化闭环 (P0, 2 周) → "AI 驱动 AI" 核心**

> **v0.11.0 修订**: 经工程评审 + 博弈论审查,在原有设计基础上增加: CAP-EVO-02 全量双轨 RuleValidator 替代单模型置信度阈值、CAP-EVO-03 A/B Split 替代固定 eval suite、CAP-EVO-05 自动熔断机制、CAP-EVO-06 用户反馈信号集成。详见 `review/ai-native-os-review.md` 和相关辩证讨论。

21. `src/evolution/insight-engine.ts` — 周期任务: 拉 D 的 snapshot + 失败 trace,聚合成"问题候选"列表(分类: context/spec/prompt/agent-stability)
22. `src/evolution/diagnostic-llm.ts` — 复用 DeepSeek,分离式两阶段调用: diagnose → RuleValidator (全量双轨) → suggestFix (仅被采纳后)
23. `src/evolution/rule-validator.ts` — 确定性规则验证引擎: Level 1 门槛 (rootCause 可查证/fix 一致性/confidence 合理/diff 可应用) + Level 2 加分 (spec 引用/量化指标/模式匹配/路径过滤)
24. `src/evolution/eval-runner.ts` — A/B Split: 从 100+ 任务池随机抽取 20 个 (Decision 5 + Monitor 15),Monitor Set 结果对 Evolution Service 不可见,每 2 周轮换任务池
25. `src/evolution/task-pool.ts` — 管理 100+ 任务池,随机抽取,定期轮换,外部注入
26. `src/evolution/evolution-service.ts` — orchestrator: 定时跑 insight → diagnostic → RuleValidator → eval → 用户反馈检查 → 熔断前置检查 → 替换 → 落 L3
27. `src/evolution/circuit-breaker.ts` — 三态熔断器 (closed/open/half-open): 连续 reject / 连续回滚 / 用户持续不满 / 能力退化 触发自动暂停
28. `src/evolution/feedback-collector.ts` — 飞书卡片 thumbs up/down 反馈采集 + 7 天滚动 satisfaction_score
29. `src/evolution/l3-memory.ts` — 长期偏好记忆存储: `~/.dev-brain/l3-memory/`,只接受 evolution-service 写入
30. 新增 metric: evolution 全系列 (~15 个 counter/gauge,含 circuit_breaker.state / satisfaction_score / a/b pass_rate 等)

**Phase F — 通信/上下文/多 Agent 增强 (P1, 2 周) → UX 与鲁棒性**

27. **通信层 (CAP-COM-01..05)**:
    - `src/gateway/streaming-pusher.ts` — 结构化事件流推送 (替代无类型文本流)
    - `src/gateway/card-renderer.ts` — 事件 → 飞书卡片区域映射 + 层级可见性控制
    - `src/gateway/event-bus.ts` — CommunicationEvent 事件总线
    - `src/gateway/signature-verifier.ts` — 验证 lark-cli 回调 HMAC-SHA256 签名
    - `src/gateway/multimodal-parser.ts` — 解析图片(OCR via MiniMax vision)/文件附件/消息中的 PR 链接
    - `src/gateway/task-done-card.ts` — 阶段总结 + 任务完成卡
    - `src/gateway/agent-identity.ts` — 多 Agent 身份注册表 (区分 Claude/Codex/DeepSeek/子Agent)
    - `src/gateway/types.ts` — CommunicationEvent / CardZone 类型定义
28. **上下文引擎 (CAP-CTX-01..04)**:
    - `src/context/l1-working-memory.ts` — 单次任务内的临时变量,带 scope 隔离 (tool_call/step/subtask)
    - `src/context/l2-task-memory.ts` — 任务级记忆,结构化 Entry (8 种 type + importance + TTL + specRef),复合评分 recall
    - `src/context/l3-long-term-memory.ts` — 长期偏好,三级目录 (prompts/preferences/decisions) + TTL,只通过 evolution-service 写入
    - `src/context/recall-strategy.ts` — 关键节点触发 + 复合评分 recall (0.4×TF-IDF + 0.3×recency + 0.3×importance)
    - `src/context/sleeptime-agent.ts` — 后台异步记忆巩固 (encode/consolidate/extract/forget/compress),替代同步 LLM 压缩
    - `src/context/types.ts` — L2Entry / L3Entry / InjectPlan / RecallResult 类型定义
    - `src/context/scorer.ts` — TF-IDF + 复合评分实现
    - `src/context/ttl-manager.ts` — TTL 过期管理
    - `src/context/inject-plan.ts` — token 预算分配 + 优先级注入 (80K 总预算, recall ≤4K)
29. **多 Agent 运行时 (CAP-MAR-01..05)** — **v0.11.0 修订**: 经 LangGraph 1.0 / 事务性快照 / Wink 自干预 行业调研增强:
    - `src/runtime/state-machine.ts` — 显式 FSM: PENDING → RUNNING → SUCCESS/FAILED/RETRYING,带非法迁移检测
    - `src/runtime/checkpoint-store.ts` — **NEW**: JSON 文件持久化,每次 transition 异步写 checkpoint,crash 可恢复
    - `src/runtime/sandbox.ts` — **修订**: PreFlight 校验 + 双路径回滚 (stash pop → git reset --hard 兜底) + guarantee 等级 (ATOMIC/BEST_EFFORT/NO_ROLLBACK)
    - `src/runtime/heartbeat.ts` — **修订**: 结构化心跳 (phase/progressPct/currentTool) + 停滞检测 (连续 3 次无进展),与 communication-layer 联动推送 ProgressEvent
    - `src/runtime/self-correction.ts` — **修订**: L1 归因 + Wink 3 类 misbehavior 分类 (specification_drift/reasoning_problem/tool_call_failure) + 分流决策 (偶发→修复路径 / 系统→进化路径 / 不可归因→待观察)
    - `src/runtime/attribution-engine.ts` — 基于 L1 可信源 (git diff / acceptance 结果 / heartbeat) 做失败归因,不依赖 Agent 自述; Wink 分类作为辅助语义层
    - `src/runtime/acceptance-pipeline.ts` — **修订**: 分层验收金字塔 FastGate (lint+typecheck < 30s) → CoreGate (unit test < 2min) → ReviewGate (reviewer agent, 非阻塞 advisory)

**Non-Goals (本 change 不做)**

- ❌ 多租户权限 / SSO
- ❌ 真实 Web UI(仅飞书卡片)
- ❌ DeepSeek 之外的 LLM 路由(诊断专用 deepseek,任务路由仍走 native claude/codex/cursor)
- ❌ 改 `~/.cc-connect/config.toml`
- ❌ 替换现有 4 个 agent (claude/codex/cursor),只加状态机/沙箱/心跳/验收包装

## Risks

| 风险 | 缓解 |
|------|------|
| `ts-morph` 启动慢 (3-5s) 阻塞 daemon | snapshot 走独立子进程,daemon 只读结果文件;cron 每日 1 次 |
| `jscpd` 输出格式不稳 | 包一层 adapter 解析,失败时 metric `code.duplication_scan_failed_total` |
| Evolution 误删/误改 prompt | eval-runner A/B Split (Decision+Monitor 双轨) + 7 天观察期 + 自动熔断 (CAP-EVO-05) + 一键回滚 (`./cli prompt revert <id>`) |
| DiagnosticLLM 道德风险 (策略性输出高置信度) | 全量双轨 RuleValidator (CAP-EVO-02) — 确定性规则验证 100% 覆盖,不依赖 LLM 自评 |
| Evolution Service Goodhart (针对 eval suite 过拟合) | A/B Split 随机抽取 + Monitor Set 轮换 (CAP-EVO-03) — Evolution Service 无法预测 eval 任务 |
| Self-Correction 导致 Agent 搭便车 (囚徒困境) | L1 归因 + 分流决策 (CAP-MAR-04) — 偶发修复,系统进化,不可归因暂存,责任明确 |
| 用户 vs Evolution Service 信息不对称导致长期信任侵蚀 | 用户反馈信号集成 (CAP-EVO-06) — satisfaction_score 作为必要条件,用户持续不满自动熔断 |
| 沙箱 git stash 冲突 | 先 `git status` 校验,冲突时直接 reject 沙箱请求,接口增加 guarantee 等级标注 |
| 心跳 30s 误杀慢 agent | 阈值 env 化 (`DEV_BRAIN_HEARTBEAT_MISSES=2`),按 runtime 实测调 |
| L3 长期记忆被污染 | 只接受 evolution-service 写入,manual 写入需 `--force` 标志并打 `l3.manual_write` 审计 |
| 多模态 OCR 误识别 | MiniMax vision 置信度 < 0.7 时退回"请用户文字描述" |
| 流式推送刷屏 | 节流 200ms,合并相邻内容,卡片 update 而非新增 |
| Eval 任务池耗尽 (< 100) | 外部注入机制: 用户真实任务匿名化 + 团队手工设计 + 对抗性任务, 目标维持 100+ |

## Verification

- `pnpm typecheck && pnpm test` 全绿(预计 561 → ~750 测试)
- `pnpm test:coverage` 维持 85%/74% 阈值
- Phase D 单测: 给一段含死代码/高复杂度/重复的 fixture TS,验证 4 个 finder 都正确
- Phase E 单测: mock eval-runner,跑 5 个标准任务集,验证通过率门槛 + 回滚路径
- Phase F 单测: state-machine 非法迁移抛错;signature 伪造的请求拒收;sandbox 失败回滚
- E2E (新加 `tests/integration/evolution-e2e.test.ts`): 跑一次完整 evolution 流程,验证 prompt 被替换 + 旧版本留底
- 回归: 现有 70 个 test files 全绿

## Acceptance Criteria

| 指标 | 目标 |
|------|------|
| 代码态观测 4 项全量覆盖 | 100% (snapshot 每日产出,无 panic) |
| `ts-morph` 单文件解析 | < 500ms (P95) |
| `jscpd` 扫描 src/ | < 30s |
| 死代码检测准确率 | ≥ 90% (人工 spot-check 20 个样本) |
| Evolution cycle 完成时间 | < 15min (增加 RuleValidator + A/B Split 后放宽) |
| RuleValidator Level 1 拦截率 | > 0% (证明在起作用), < 50% (不过度拦截) |
| A/B Split Decision Set 通过率提升 | 新 prompt 显著高 +5% 才替换 |
| Monitor Set 能力退化检测 | 下降 > 3% 触发 alert |
| 沙箱回滚成功率 | 100% (失败 → git stash pop 必须恢复) |
| 心跳误杀率 | < 1% (按 1000 任务统计) |
| 自我进化 prompt 被采纳率 | 30~70% (太低 = insight 失效,太高 = 风险) |
| Self-Correction 一次成功率 (修复路径) | ≥ 40% (v0.10.0 retry 一次成功率约 25%,baseline 提升 15pp) |
| 熔断器误触发率 | < 5% (因正常 fluctuation 而非真实异常) |
| 用户满意度 (satisfaction_score) | ≥ -0.1 (中性偏正) |
| 流式推送延迟 | < 200ms (节流后) |
| 多模态 OCR 准确率 | ≥ 85% (在 20 张测试图) |
| 签名鉴权伪造请求拒收率 | 100% |
| 覆盖率 | 85%/74% 维持 |

## 关联文件

**新增 (Phase D)**:
- `src/observability/code-health/{ast-analyzer,deadcode-finder,complexity-reporter,duplication-scanner,zombie-detector,snapshot}.ts`
- `tests/unit/code-health/*.test.ts`

**新增 (Phase E)**:
- `src/evolution/{insight-engine,diagnostic-llm,rule-validator,eval-runner,task-pool,evolution-service,circuit-breaker,feedback-collector,l3-memory}.ts`
- `src/evolution/types.ts` — Insight / Diagnostic / EvalResult / EvolutionRun / Attribution / L1FailureTrace 类型定义
- `config/rule-validator.yaml` — RuleValidator Level 2 规则配置
- `tests/eval/pool/*.yaml` — 100+ 任务池
- `tests/unit/evolution/*.test.ts`
- `tests/integration/evolution-e2e.test.ts`

**新增 (Phase F)**:
- `src/gateway/{streaming-pusher,card-renderer,event-bus,signature-verifier,multimodal-parser,task-done-card,agent-identity,types}.ts`
- `src/context/{l1-working-memory,l2-task-memory,l3-long-term-memory,recall-strategy,sleeptime-agent,types,scorer,ttl-manager,inject-plan}.ts`
- `src/runtime/{types,state-machine,checkpoint-store,sandbox,heartbeat,self-correction,attribution-engine,acceptance-pipeline}.ts`
- `tests/unit/{gateway,context,runtime}/*.test.ts` (~25 runtime 场景)

**修改**:
- `src/observability/metrics.ts` — 加 ~20 新 metric (4 code + ~10 evolution + ~10 context)
- `src/context/compressor.ts` — 移除 (功能合并到 SleeptimeContextAgent)
- `ops/grafana/dev-brain-dashboard.json` — 加 2 panel
- `src/brain/brain-engine.ts` — 接入 recall-strategy, inject-plan, evolution-service, acceptance-pipeline
- `src/gateway/feishu-gateway.ts` — 接入 streaming-pusher, signature-verifier
- `src/runtime/orchestrator.ts` — 替换 ad-hoc retry 为 state-machine + self-correction
- `src/config/env.ts` — 新增 ~17 env: 含 recall 权重 / L2 token 阈值 / InjectPlan 预算 / circuit breaker 等
- `package.json` — 新增 3 prod dep: `ts-morph` `escomplex` `jscpd` (调子进程)

**文档**:
- `docs/code-health.md` (新) — 4 项观测含义 + Playbook
- `docs/evolution.md` (新) — 自我进化流程 + 评测套件 + 回滚指南
- `docs/observability.md` (扩) — 加 8 个新 metric 含义
- `docs/USAGE.md` (扩) — 加"代码健康检查" + "prompt 回滚" + "Self-Correction 调试" 章
