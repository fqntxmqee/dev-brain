---
demand-id: DM-20260601-001
title: Dev Brain 实施任务
created: 2026-06-01
archived: 2026-06-01
---

# Dev Brain 实施任务

## Phase 1 — 飞书 → Brain 闭环

| ID | 任务 | 关联 L4/L5 | 状态 |
|----|------|-----------|------|
| T-01 | 项目骨架 package.json / tsconfig / bootstrap | L4-BE-BRAIN-02 | done |
| T-02 | OpenSpec 四件套 | — | done |
| T-03 | IntentParser + FeishuReporter | L4-BE-BRAIN-01, L5-BRAIN-01 | done |
| T-04 | BrainEngine 计划 + 审批门控 | L4-BE-BRAIN-02, L5-BRAIN-02 | done |
| T-05 | Adapter 接口 + Registry + stub | L4-BE-BRAIN-03 | done |
| T-06 | cc-connect Client 骨架 | L4-BE-BRAIN-07 | done |
| T-07 | CLI `dev-brain start` / `dev-brain plan` | L4-BE-BRAIN-01 | done |
| T-08 | 单元测试 intent / planner / brain | L5-BRAIN-01~02 | done |
| T-17 | offline stub + 集成测试 + acceptance-report | L5-BRAIN-01/02/05 | done |

## Phase 2 — 真实 Adapter 集成

| ID | 任务 | 关联 L4/L5 | 状态 |
|----|------|-----------|------|
| T-09 | cc-connect API 协议实现 | L4-BE-BRAIN-07, L5-BRAIN-03 | done |
| T-10 | ClaudeCodeAdapter 真实调用 | L4-BE-BRAIN-04 | done |
| T-11 | CodexAdapter 真实调用 | L4-BE-BRAIN-05 | done |
| T-12 | CursorAdapter @cursor/sdk | L4-BE-BRAIN-06, L5-BRAIN-03 | done |
| T-13 | Feishu Gateway lark-cli 子进程 | L4-BE-BRAIN-01 | done |
| T-18 | doctor + probe CLI | L4-BE-BRAIN-07 | done |

## Phase 3 — 治理与并行

| ID | 任务 | 关联 L4/L5 | 状态 |
|----|------|-----------|------|
| T-14 | Governance 文件锁 + 并行 Worker | L5-BRAIN-04 | done |
| T-15 | 飞书进度卡片 | CAP-GW-02 | done |
| T-16 | cc-connect headless 配置迁移 | design §6 | done |

## Phase 4 — 生产可用

| ID | 任务 | 关联 L4/L5 | 状态 |
|----|------|-----------|------|
| T-19 | 飞书卡片按钮审批 | CAP-GW-02, L5-BRAIN-06 | done |
| T-20 | cc-connect Bridge 异步回复 | L4-BE-BRAIN-07 | done |
| T-21 | headless `--apply` 生产切换 | design §6 | done |
| T-22 | 集成测试 + Phase 4 验收 | L5-BRAIN-06 | done |
