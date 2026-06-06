---
demand-id: DM-20260606-002
change: spec-driven-workflow
status: developing
---

# spec-driven-workflow: 飞书需求 → 意图 → 辩论 → OpenSpec → 长程执行 → Cursor

## Motivation

dev-brain v0.9.0 已实现"飞书收需求 → Brain 规划 → 派发 native agent → 飞书回卡片"的端到端闭环。
但当前流程对 **需求质量** 的保障缺失:

| 缺口 | 现象 | 业务影响 |
|------|------|---------|
| **A. 一次性拆任务,无澄清** | 飞书发来 1 句话需求,Brain 直接 createPlan 拆 3 个子任务 | 用户表述不清时,Brain 按字面意思误解,做完返工 |
| **B. 无意图分类** | 任何文本都走同一条 plan 路径 | "为什么 dev-brain 不响应?"和"加个新接口"用同一流程,慢且低质 |
| **C. 单一模型独立理解** | Brain 拆任务只用 Claude 1 个 LLM | 没有交叉验证,容易遗漏盲点 |
| **D. 无需求规约沉淀** | 飞书聊完即忘,后续无法回查"当时为什么这么设计" | 团队知识流失,新人 onboard 困难 |
| **E. 短任务为主,无法跑长任务** | Brain 派发 3 子任务秒级完成;若需求是"重构整个 trade 模块"就跑不动 | 大需求被拒之门外 |
| **F. 进程崩溃丢上下文** | 没有 checkpoint,2 小时任务跑一半 OOM 全没了 | 算力 + 信任双重损失 |
| **G. 上下文窗口无预算** | 累积到 token 上限直接 throw,长会话中断 | 同样算力损失 |
| **H. 子任务失败不重试** | 偶发超时直接判失败 | 一次偶然就重做整轮 |
| **I. 无用户规则注入** | Brain 派发 agent 不带用户的 CLAUDE.md / 规则 | 输出风格飘忽,不遵循团队约定 |
| **J. 端到端难追溯** | 飞书收完需求后,无法一键回查"这条需求从哪来到哪去" | oncall 排查困难 |

## Scope (本 change — v0.10.0+)

**Phase A — Spec-driven 闭环 + 长程自主 (P0, 1-2 周)**

1. **意图识别** (`src/intent/`): DeepSeek API 5 档分类 (feature/bug/refactor/query/config),失败降级 MiniMax haiku
2. **需求澄清辩论** (`src/debate/`): Claude + Codex 1-3 轮 game-theoretic debate,共识率 ≥ 0.85 收敛,超 3 轮上抛用户
3. **OpenSpec 自动生成** (`src/openspec/generator.ts`): 共识 → `openspec/changes/{id}/proposal.md` + `specs/*.md` (五段式 + Given/When/Then)
4. **飞书 `/spec` 入口**: 从飞书直接走 1→2→3→5 卡片提交
5. **草稿卡审门**: OpenSpec 生成后先放草稿(不入 git),飞书卡片点"批准"才入 `openspec/changes/`
6. **长程自主** (`src/runtime/`): 5 模块
   - `checkpoint.ts` — 60s 写状态到 `~/.dev-brain/checkpoints/`
   - `context-budget.ts` — 累计 token > 150K 触发 auto-summarise
   - `retry.ts` — 指数退避 1s/2s/4s/8s, max 5 次;429 限流感知
   - `resume.ts` — 启动扫描 `~/.dev-brain/runtime/` 自动续跑 in_progress 任务
   - `progress.ts` — 30s 上报进度到飞书,`/status` 增强显示 ETA + tokens + checkpoint
7. **Trace 贯穿** (`src/observability/trace.ts`): AsyncLocalStorage 注入 trace_id,所有 logger/metric 携带
8. **10 新 metric**: `intent.classify.duration_seconds` / `debate.rounds` / `debate.consensus_score` / `openspec.coverage` / `runtime.task_duration_seconds` / `runtime.checkpoint_writes` / `runtime.context_budget_triggers` / `runtime.resume_count` / `runtime.retry_total` / `user.feedback_acceptance_rate`

**Phase B — 指令遵循 (P1, 1-2 周)**

9. `src/agent/inject-rules.ts` — `~/.claude/rules/**/*.md` 注入每个 agent 调用的 system prompt
10. `src/agent/track-rules.ts` — 每次调用记 `applied_rules[]` + `rule_violations[]`
11. `src/agent/feedback-memory.ts` — 用户改 → 写 feedback memory → 下次自动遵循

**Phase C — 完整可观测 (P1, 1 周)**

12. 5 Grafana panel: 辩论收敛曲线 / 意图分布 / 上下文预算 / 续跑事件 / 反馈接受率
13. `docs/observability.md` — 10 metric 含义 + 排查 playbook
14. `docs/USAGE.md` 加"长程任务调试指南"章

## Non-Goals (本 change 不做)

- ❌ 季度路线图 / 战略规划 — 那是"长城"歧义,本 change 不覆盖
- ❌ 多租户 / 多用户权限管理
- ❌ 真实的 web UI (只用飞书卡片)
- ❌ cc-connect 派发路径(本 change 全部走 native)
- ❌ DeepSeek 之外的多家 LLM 路由 (单家即可,后续再扩)

## Risks

| 风险 | 缓解 |
|------|------|
| DeepSeek 不可用 | MiniMax haiku 降级;env opt-in 灰度 |
| 辩论停滞(>3 轮不收敛) | 上抛用户,不让死循环 |
| OpenSpec 草案质量低 | 飞书卡审门 + 影响面报告辅助 |
| 长程进程崩溃 | 60s checkpoint + 启动扫描续跑;幂等保证 |
| 上下文超限爆掉 | 150K 触发 auto-summarise;保留最近 20K + 早期摘要 |
| MiniMax/DeepSeek 限流死锁 | 429 感知 + 排队 30s;持续 429 5min 降级 haiku |
| 指令遵循过度严格 | 任务级 `遵守:` override;违规可视化供裁决 |
| trace_id 漏注入 | 关键 logger.info lint + 覆盖率测试 |

## Verification

- `pnpm typecheck && pnpm test` 全绿
- `pnpm test:coverage` stmt ≥ 80%, branch ≥ 70%
- 端到端测试 `tests/e2e/spec-workflow.test.ts`: 文本 → DeepSeek → debate → OpenSpec 草案
- 长程测试 `tests/e2e/long-running.test.ts`: 模拟 2h 任务,验证 checkpoint 写盘 + resume 续跑
- 真实 `pnpm cli -- spec "trade 模块加日期筛选"` (需 `DEV_BRAIN_DEEPSEEK_API_KEY`)
- 飞书 `/spec` 走完整链路
- trace_id 全程可追:`tail -f /tmp/dev-brain.log | jq 'select(.trace_id=="tr-xxx")'`

## Acceptance Criteria

| 指标 | 目标 |
|------|------|
| 一句话需求端到端 | < 30s 出 OpenSpec |
| 复杂多模块需求 | < 2min 出 OpenSpec + 辩论日志 |
| 辩论自动收敛率 | ≥ 80% |
| OpenSpec 草案"基本不改"率 | ≥ 80% |
| trace_id 注入率(关键路径) | 100% |
| 长任务 (2h) 跨进程恢复成功率 | ≥ 95% |
| auto-summarise 后上下文溢出率 | < 1% |
| 子任务重试一次成功率 | ≥ 60% |
| 重辩论一次成功率 | ≥ 80% |
| 覆盖率 | 80%/70% |

## 关联文件

- `src/intent/` — 新增
- `src/debate/` — 新增
- `src/runtime/` — 新增
- `src/openspec/generator.ts` — 新增
- `src/agent/inject-rules.ts` / `track-rules.ts` / `feedback-memory.ts` — 新增 (Phase B)
- `src/observability/trace.ts` — 新增
- `src/observability/metrics.ts` — 扩展(加 10 metric)
- `src/cli/cli.ts` — 扩展(`spec` 子命令)
- `src/gateway/feishu-gateway.ts` — 扩展(`/spec` 命令 + card.action)
- `src/brain/brain-engine.ts` — 扩展(trace_id 贯穿 + 续跑)
- `src/config/env.ts` — 扩展(DeepSeek key / maxDebateRounds / checkpoint interval)
- `tests/unit/{intent,debate,runtime,agent}/*` — 新增
- `tests/e2e/{spec-workflow,long-running}.test.ts` — 新增
- `docs/USAGE.md` / `docs/observability.md` — 新增/扩展
- `ops/grafana/dev-brain-dashboard.json` — 扩展
