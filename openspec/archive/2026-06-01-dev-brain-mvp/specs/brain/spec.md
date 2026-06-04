---
demand-id: DM-20260601-001
change: dev-brain-mvp
status: archived
---

# Brain Engine Spec (Delta)

## CAP-BRAIN-01 任务规划

**Given** 用户发送自然语言需求  
**When** createPlan 被调用  
**Then** 生成 DAG 子任务及 runtime 分配

## CAP-BRAIN-02 审批门控

**Given** 存在 awaiting_approval 计划  
**When** 用户 /approve 或卡片批准  
**Then** 执行子任务并返回汇总

## L5 锚点

- L5-BRAIN-01 ~ L5-BRAIN-06（见 acceptance-report.md §11）
