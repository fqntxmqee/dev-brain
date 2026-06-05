---
demand-id: DM-20260605-002
archived: 2026-06-05
version: dev-brain v0.5.0
status: ARCHIVED
---

# S7 归档包 — Dev Brain 生产加固 (P0~P5)

本目录为需求 **DM-20260605-002** 的归档快照。由 `openspec/changes/production-hardening/` 整体迁入（2026-06-05 完成）。

## 归档六件套

| # | 产物 | 路径 |
|---|------|------|
| 1 | proposal.md | `./proposal.md`（含 Archive Information 段） |
| 2 | design.md | `./design.md` |
| 3 | tasks.md | `./tasks.md`（78/78 = done） |
| 4 | acceptance-report.md | `./acceptance-report.md` |
| 5 | specs/ | `./specs/{10 个组件}/spec.md`（status: archived） |

## 交付摘要

- **P0 ~ P5 78/78 任务** 全部完成
- **类型检查 + Lint + 测试** 全绿
  - `pnpm typecheck`：0 错误
  - `pnpm lint`：0 警告
  - `pnpm test`：149/149 通过（32 文件）
  - 覆盖率：62% statements / 55% branches
- **53 个 commit** 在 master 之上；**PR #1** OPEN 待审
- **T-28 N/A**：proper-lockfile 用 pnpm-lock 等价替代

## 关键能力（节选）

| 能力 | 任务 | 落地位置 |
|------|------|----------|
| 平台无关抽象 | T-32/T-33 | `src/gateway/common/message-gateway.ts` |
| 9 类 intent + 短 ID | T-49/T-51 | `src/gateway/intent-parser.ts`、`src/brain/task-planner.ts` |
| 状态机 + cancel 意图 | T-56/T-57 | `src/adapters/claude-code-adapter.ts` |
| Bridge 错误前缀 + WS 重试 | T-58/T-59 | `src/adapters/cc-connect/bridge.ts` |
| Postmortem 落盘 | T-62/T-65 | `src/brain/postmortem-store.ts` |
| 子任务重试 + prompt 上限 | T-64/T-66 | `src/brain/brain-engine.ts`、`src/gateway/feishu-gateway.ts` |
| 不可达告警 + 凭证诊断 | T-72/T-74 | `src/cli/doctor.ts` |
| cc-connect schema_version | T-77/T-78 | `src/cli/migrate-headless.ts`、`src/governance/file-lock.ts` |
| 模块化 + 部署 | T-29/T-37/T-38 | `src/adapters/cc-connect/`、`src/observability/`、`deploy/` |

## 合入后动作

1. GitHub PR #1 合并到 master
2. Git tag：`v0.5.0`（dev-brain 下一个发布版）
3. 删除 feature 分支：`feat/production-hardening`
4. （可选）更新 CHANGELOG 记录本次加固

## 后续 change 候选

- `production-observability` — 真实 metrics/SLO（基于本批 T-37 起的 MetricsRegistry）
- `gateway-platform-abstraction` — Slack/钉钉接入（基于 T-32 平台无关抽象）
- `BRAIN-06-abort-real` — cc-connect `POST /cancel` 端点（如官方支持）
