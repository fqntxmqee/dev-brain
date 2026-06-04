---
demand-id: DM-20260601-001
title: Dev Brain 架构设计
created: 2026-06-01
archived: 2026-06-01
---

# Dev Brain 架构设计

（归档快照 — 完整内容见 `openspec/changes/dev-brain-mvp/design.md`）

## 分阶段交付

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | Gateway + Brain 闭环 | ✅ |
| 2 | cc-connect + Cursor SDK | ✅ |
| 3 | 并行 Worker + 文件锁 + 卡片 | ✅ |
| 4 | 卡片按钮 + Bridge + headless --apply | ✅ |

## cc-connect 演进

三 Bot 平行 → Brain Bot + headless Worker（`migrate-headless --apply`）
