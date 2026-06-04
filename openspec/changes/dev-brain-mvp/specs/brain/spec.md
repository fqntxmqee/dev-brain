---
demand-id: DM-20260601-001
change: dev-brain-mvp
status: developing
---

# Brain Engine Spec (Delta)

## CAP-BRAIN-01 任务规划

**Given** 用户发送自然语言需求  
**When** createPlan 被调用  
**Then** 生成 3 个子任务（探索 / 实现 / 验证）及 runtime 分配

## CAP-BRAIN-02 审批门控

**Given** 存在 awaiting_approval 计划  
**When** 用户发送 /approve  
**Then** 执行子任务并返回汇总  
**When** 用户未 /approve  
**Then** 不调用任何 Adapter

## L5 锚点

- L5-BRAIN-01: 飞书发需求 → 收到任务计划（含 /approve 提示）
- L5-BRAIN-02: /approve → Lead 拆分 DAG 并执行
- L5-BRAIN-05: 执行完成 → 飞书收到汇总
