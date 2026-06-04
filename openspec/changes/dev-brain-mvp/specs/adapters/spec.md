---
demand-id: DM-20260601-001
change: dev-brain-mvp
status: developing
---

# Agent Adapters Spec (Delta)

## CAP-ADPT-01 统一接口

所有 Adapter 实现：

```typescript
interface AgentAdapter {
  readonly runtime: AgentRuntime;
  send(request: AdapterRequest): AsyncIterable<AdapterEvent>;
  cancel(sessionKey: string): Promise<void>;
  status(sessionKey: string): Promise<AdapterSessionStatus>;
}
```

## Runtime 映射

| Runtime | Phase 1 | Phase 2 |
|---------|---------|---------|
| claude-code | cc-connect stub | cc-connect workspace-claude |
| codex | cc-connect stub | cc-connect workspace-codex |
| cursor | stub | @cursor/sdk local |

## L5 锚点

- L5-BRAIN-03: 三 Runtime 各完成一次真实子任务（Phase 2）
- L5-BRAIN-04: 跨 Agent 文件锁（Phase 3，dev-brain 内置 Governance）
