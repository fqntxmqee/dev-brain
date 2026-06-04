---
demand-id: DM-20260601-001
title: Dev Brain — 飞书指挥的多 Agent 开发大脑
source: 用户规划
priority: P0
status: ARCHIVED
l1-domain: agent
created: 2026-06-01
archived: 2026-06-01
---

# Dev Brain — 飞书指挥的多 Agent 开发大脑

## 1. 原始描述

> 基于 cc-connect 和飞书，开发一个 multi agent 系统，控制本地的 Claude Code、Codex、Cursor 进行开发，再通过飞书指挥这个 multi agent。Multi agent 定位一个大脑（Brain）角色。
>
> 项目名：`dev-brain`，独立仓库根目录。

## 2. 澄清记录

### Q1: Brain 与 cc-connect 的关系？
**A**: cc-connect 降级为 Worker 执行通道（Claude Code / Codex），Brain 本身不是 cc-connect 的第四种 agent type，而是独立 Orchestrator。Cursor 走 `@cursor/sdk` 本地 runtime。 — 2026-06-01

### Q2: 飞书入口形态？
**A**: 单一 Brain Bot 作为指挥入口；cc-connect 三 Bot 逐步改为 headless（仅 API 调用），不再让用户直接对话。 — 2026-06-01

### Q3: 与 workspace 内其他项目关系？
**A**: dev-brain 是完全独立的项目根目录，编排逻辑内置在 `src/orchestrator/`，不依赖 sibling 仓库。 — 2026-06-01

### Q4: 首版范围？
**A**: Phase 1 飞书 → Brain 闭环（计划卡片 + 审批 + 汇总）；Phase 2 接入三 Adapter 真实执行。 — 2026-06-01

## 3. 澄清范围

### 3.1 L1-L5 映射

| 层级 | 资产 ID | 名称 | 状态 |
|------|---------|------|------|
| L1 | agent | 智能体协同 | 复用 |
| L2 | L2-AGENT-02 | 远程指挥开发 | 新增 |
| L3-BE | L3-BE-BRAIN-01 | 飞书接收需求活动 | 新增 |
| L3-BE | L3-BE-BRAIN-02 | 任务规划与审批活动 | 新增 |
| L3-BE | L3-BE-BRAIN-03 | 多 Agent 调度执行活动 | 新增 |
| L4-BE | L4-BE-BRAIN-01 | Feishu Gateway | 新增 |
| L4-BE | L4-BE-BRAIN-02 | Brain Engine | 新增 |
| L4-BE | L4-BE-BRAIN-03 | Agent Adapter Registry | 新增 |
| L4-BE | L4-BE-BRAIN-04 | Claude Code Adapter | 新增 |
| L4-BE | L4-BE-BRAIN-05 | Codex Adapter | 新增 |
| L4-BE | L4-BE-BRAIN-06 | Cursor Adapter | 新增 |
| L4-BE | L4-BE-BRAIN-07 | cc-connect Client | 新增 |
| L5 | L5-BRAIN-01 ~ 06 | 见 acceptance-report.md | 已实现 |

### 3.2 范围

**In Scope (MVP)**:
- Phase 1–4 全部能力（见 tasks.md）

**Out of Scope**:
- 长期记忆检索
- 多租户 / 持久化任务存储
