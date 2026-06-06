# spec-driven-workflow — Tasks

## Phase A: Spec-driven 闭环 + 长程 (P0, 1-2 周)

### A1. OpenSpec 自身 (已完成 ✅)
- [x] 起草 proposal.md (五段式 + 验收 + 风险)
- [x] spec/intent/spec.md (CAP-INT-01/02/03)
- [x] spec/debate/spec.md (CAP-DEB-01/02/03/04)
- [x] spec/runtime/spec.md (CAP-RT-01..07)

### A2. Intent 识别 (`src/intent/`)
- [ ] `deepseek-adapter.ts` — HTTPS client,5 档分类 prompt
- [ ] `classifier.ts` — 主 orchestrator,异常降级
- [ ] `fallback-classifier.ts` — MiniMax haiku 兜底
- [ ] `cache.ts` — LRU + TTL 缓存
- [ ] `types.ts` — Intent / IntentType / IntentClassifyError
- [ ] `tests/unit/intent-classifier.test.ts` — mock DeepSeek,5 档
- [ ] `tests/unit/intent-cache.test.ts` — 命中/失效

### A3. Debate (`src/debate/`)
- [ ] `clarify-loop.ts` — R1/R2/R3 编排,带超时
- [ ] `arbiter.ts` — 共识率 + 停滞检测
- [ ] `types.ts` — IndependentAnalysis / CrossCritique / Consensus
- [ ] `tests/unit/debate-clarify-loop.test.ts` — mock Claude+Codex
- [ ] `tests/unit/debate-arbiter.test.ts` — 共识/停滞

### A4. Runtime 长程 (`src/runtime/`)
- [ ] `checkpoint.ts` — 60s 写盘 + 原子 rename + 滚动
- [ ] `context-budget.ts` — token 累计 + auto-summarise
- [ ] `retry.ts` — 指数退避 + 限流感知
- [ ] `resume.ts` — 启动扫描 + 续跑
- [ ] `progress.ts` — 30s 上报 + 飞书推送
- [ ] `types.ts` — Checkpoint / Runtime / ProgressReport
- [ ] `tests/unit/runtime/checkpoint.test.ts`
- [ ] `tests/unit/runtime/context-budget.test.ts`
- [ ] `tests/unit/runtime/retry.test.ts`
- [ ] `tests/unit/runtime/resume.test.ts`
- [ ] `tests/unit/runtime/progress.test.ts`

### A5. OpenSpec Generator (`src/openspec/`)
- [ ] `generator.ts` — 共识 → `openspec/changes/{id}/proposal.md` + `specs/*.md` 模板
- [ ] `templates/proposal.md` — 五段式模板
- [ ] `templates/spec.md` — Given/When/Then 模板
- [ ] `tests/unit/openspec-generator.test.ts`

### A6. Observability (`src/observability/`)
- [ ] `trace.ts` — AsyncLocalStorage 注入 trace_id
- [ ] `metrics.ts` — 加 10 metric 注册
- [ ] `events.ts` — 结构化事件常量
- [ ] 关键路径 logger.info 携带 trace_id (lint 覆盖)
- [ ] `tests/unit/trace.test.ts`

### A7. Gateway / CLI 接入
- [ ] `src/gateway/feishu-gateway.ts` — `/spec` 命令 + card.action 草稿提交
- [ ] `src/cli/cli.ts` — `spec` 子命令
- [ ] `src/brain/brain-engine.ts` — 接入 Intent + Debate + OpenSpec
- [ ] `src/brain/brain-engine.ts` — Runtime 调用点 (CAP-RT-01..07)
- [ ] `src/config/env.ts` — DeepSeek key / debateMaxRounds / checkpointInterval / contextBudgetMaxTokens

### A8. 端到端测试
- [ ] `tests/e2e/spec-workflow.test.ts` — 文本 → 意图 → 辩论 → OpenSpec
- [ ] `tests/e2e/long-running.test.ts` — 模拟 2h 任务,验证 checkpoint + resume
- [ ] 覆盖率 ≥ 80%/70%

### A9. 提交
- [ ] `git commit -m "feat(spec-driven-workflow): phase A — intent + debate + runtime + openspec generator"`
- [ ] `git push origin master`

## Phase B: 指令遵循 (P1, 1-2 周)

### B1. 规则注入 (`src/agent/`)
- [ ] `inject-rules.ts` — `~/.claude/rules/**/*.md` 注入 system prompt
- [ ] `track-rules.ts` — `applied_rules[]` + `rule_violations[]`
- [ ] `feedback-memory.ts` — 用户改 → feedback memory 固化
- [ ] `types.ts` — Rule / Violation / Feedback
- [ ] `tests/unit/agent/inject-rules.test.ts`
- [ ] `tests/unit/agent/track-rules.test.ts`
- [ ] `tests/unit/agent/feedback-memory.test.ts`

### B2. CLI 暴露
- [ ] `src/cli/cli.ts` — `rules` 子命令 (查看/编辑/测试注入)
- [ ] `src/config/env.ts` — `rulesPaths` / `feedbackMemoryPath`

### B3. 提交
- [ ] `git commit -m "feat(agent): inject rules + track violations + feedback memory"`

## Phase C: 完整可观测 (P1, 1 周)

### C1. Grafana
- [ ] `ops/grafana/dev-brain-dashboard.json` — 加 5 panel
  - 辩论收敛曲线 (histogram_quantile on debate.rounds)
  - 意图分布饼图 (sum by intent)
  - 上下文预算触发 (rate on context_budget_triggers)
  - 续跑事件 (rate on resume_count)
  - 反馈接受率 (gauge on feedback_acceptance_rate)

### C2. 文档
- [ ] `docs/observability.md` — 10 metric 含义 + 排查 playbook
- [ ] `docs/USAGE.md` — 加"长程任务调试指南"章

### C3. 提交
- [ ] `git commit -m "docs(observability): dashboard + 10 metric reference + long-running playbook"`

## Done Criteria

- [ ] 全部 P0 任务完成
- [ ] `pnpm typecheck && pnpm test` 全绿
- [ ] 覆盖率 80%/70%
- [ ] 真实 `pnpm cli -- spec "..."` 走通
- [ ] 飞书 `/spec` 端到端 demo 通
- [ ] `openspec/changes/spec-driven-workflow/` archive (需求工作流本身的 OpenSpec 已实现)
