---
demand-id: DM-20260601-001
title: Dev Brain 技术方案
author: AI Assistant
created: 2026-06-01
---

# 技术方案 — Dev Brain

## 1. 背景与动机

用户已通过 cc-connect 将 Claude Code、Codex、Cursor 分别绑定到三个飞书 Bot，形成三条互不感知的 1:1 通道。缺少统一的任务分解、冲突仲裁与进度汇总。

Dev Brain 在飞书与本地开发 Agent 之间插入**大脑层**，实现：

- **单一指挥入口**：一个 Brain Bot 接收自然语言需求
- **层级调度**：Lead 规划 → Worker 并行执行 → Reviewer 审查
- **多运行时适配**：Claude Code / Codex 经 cc-connect，Cursor 经 SDK
- **可治理**：内置 TaskOrchestrator，Phase 3+ 扩展文件锁与审计

## 2. 核心 Capabilities

| Capability ID | 名称 | 关联 L4 |
|---------------|------|---------|
| CAP-GW-01 | 飞书消息订阅与路由 | L4-BE-BRAIN-01 |
| CAP-GW-02 | 交互卡片（计划/进度/汇总） | L4-BE-BRAIN-01 |
| CAP-GW-03 | 意图解析（需求/审批/状态/取消） | L4-BE-BRAIN-01 |
| CAP-BRAIN-01 | 任务规划与子任务分配 | L4-BE-BRAIN-02 |
| CAP-BRAIN-02 | 审批门控 | L4-BE-BRAIN-02 |
| CAP-BRAIN-03 | Agent 路由策略 | L4-BE-BRAIN-02 |
| CAP-ADPT-01 | Adapter 统一接口 | L4-BE-BRAIN-03 |
| CAP-ADPT-02 | cc-connect Unix Socket 客户端 | L4-BE-BRAIN-07 |
| CAP-ADPT-03 | Cursor SDK 适配 | L4-BE-BRAIN-06 |

## 3. 技术选型

| 维度 | 选型 | 理由 |
|------|------|------|
| 语言 | TypeScript 5.x strict | Node.js 20+，项目自包含 |
| 运行时 | Node.js 20+ | cc-connect / lark-cli 生态 |
| 编排核心 | dev-brain 内置 TaskOrchestrator | 项目自包含，无 sibling 依赖 |
| 飞书接入 | lark-cli event + im | 已有 skill 与本地 CLI |
| Claude/Codex | cc-connect api.sock | 本地已部署 |
| Cursor | @cursor/sdk local | 官方 SDK |

## 4. 风险与缓解

| 风险 | 缓解 |
|------|------|
| cc-connect API 未公开文档 | 先 stub + 日志抓包；必要时 fallback CLI |
| 飞书卡片回调复杂度 | Phase 1 文本指令 `/approve` 为主 |
| 多 Agent 文件冲突 | Phase 3 内置 Governance 文件锁 |
| 长任务超时 | Adapter 层 timeout + 飞书进度推送 |
