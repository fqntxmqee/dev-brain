---
demand-id: DM-20260605-002
change: production-hardening
status: archived
---

# Brain Engine Spec (Delta)

继承 `dev-brain-mvp/specs/brain/spec.md` 的 `CAP-BRAIN-01/02/03`（任务规划 / 审批门控 / Agent 路由）。本 change 增补用户视角与一致性相关的可执行契约：

## CAP-BRAIN-01 任务规划语义修正

**Given** `src/brain/task-planner.ts:21` 当前 `return index % 2 === 0 ? 'codex' : 'codex';` 真 bug  
**When** 关键词不命中 claude-code / cursor / 不命中 CODE_KEYWORDS  
**Then** 返回值在 `['claude-code', 'cursor', 'codex']` 三者间按 index 均匀分配；首选项仍是 `codex` 之外的两者交替

**Then** 验证：100 个不命中任何关键词的 description 分布应近似 `{ claude-code: 34, cursor: 33, codex: 33 }`（±2 容差）

## CAP-BRAIN-02 pending 计划覆盖告警

**Given** `BrainEngine.pendingByChat = Map<chatId, plan>` 一 chat 一 plan  
**When** 同一 chatId 在已有 pending 计划时再次 `createPlan`  
**Then**：
- 不直接覆盖；新计划进入等待队列
- 飞书/CLI 立即回复「⚠️ 已有待审批任务 `<旧 taskId 短 8 字符>`，回复 `/cancel` 取消后再发新需求」
- 旧计划保持原状；用户 `/cancel` 旧计划后新计划才生效
- 队列上限 3 条；超出返 `TaskQueueFullError` 飞书错误卡片

## CAP-BRAIN-03 全量输出持久化

**Given** 当前 `BrainEngine.formatStatusText` 与飞书汇总卡片都 `output.slice(0, 200)` 截断，**全量输出永久丢失**  
**When** 整改后  
**Then**：
- 全量子任务输出写入 `~/.dev-brain/tasks/<taskId>/<subTaskId>.txt`
- 飞书汇总卡片仅展示首 200 字符 + 「📎 完整输出：`~/.dev-brain/tasks/<taskId>/`」
- CLI `pnpm cli -- show <taskId> --subtask <subTaskId>` 可读全量
- 飞书侧发 `完整 <taskId> <subTaskId>` 触发 Reporter 返回 1KB 分页文本（防 ARG_MAX）

## CAP-BRAIN-04 任务 ID 展示口径统一

**Given** 当前 taskId 全长 36 字符但 CLI/卡片只 `.slice(0, 8)`（8 字符 birthday 算 1 万任务 ~1% 碰撞）  
**When** 整改后  
**Then**：
- 短 ID 改用 `taskId.slice(0, 12)`（碰撞概率降至百万分之一）
- CLI / 飞书 / 日志 / 卡片 / state.json **全部** 12 字符口径一致
- sessionKey 构造统一：`dev-brain:task:<taskId-12>:subtask:<subTaskId-12>`（不再混用 `dev-brain:probe:...` 等临时模式）
- 12 字符短 ID 不可解析为完整 ID 时，状态卡显式标注「短 ID 不可逆，请用完整 taskId」

## CAP-BRAIN-05 子任务失败 retry

**Given** 当前失败子任务只能整任务重跑  
**When** 整改后  
**Then**：
- `pnpm cli -- retry <taskId>` 与飞书 `/retry <taskId>` 重跑所有 `failed`/`blocked` 子任务
- 已 `completed` 子任务不重跑（除非 `--force`）
- retry 进入 BrainEngine 新的 `BrainTaskPlan`，taskId 标 `-r<N>` 后缀；原 task 结果保留
- 重试上限 3 次，超出走 `MaxRetryExceededError` 飞书错误

## CAP-BRAIN-06 cancel 中断正在执行子任务

**Given** 当前 `Adapter.cancel()` 全是 no-op，`/cancel` 只能删 pending  
**When** 整改后  
**Then**：
- `BrainEngine.cancelTask(taskId)` 调用所有 `executing` 子任务的 `adapter.cancel(sessionKey)`
- Adapter.cancel 真正生效（见 adapters CAP-ADPT-06）
- 飞书发送「⛔ 任务已取消」进度卡片
- cancel 信号 5s 内未响应则强制标记 `failed` 并 stderr 告警

## CAP-BRAIN-07 post-mortem 落盘

**Given** 任务执行后 prompt/输出/耗时/锁等待时间不落盘，无法复盘  
**When** 整改后  
**Then** 每个 task 结束写 `~/.dev-brain/tasks/<taskId>/postmortem.json`：
```json
{
  "taskId": "...",
  "chatId": "...",
  "description": "...",
  "createdAt": "...",
  "approvedAt": "...",
  "completedAt": "...",
  "subTasks": [
    { "subTaskId": "...",
      "runtime": "claude-code",
      "description": "...",
      "promptSent": "...",
      "output": "...",
      "status": "completed|failed|blocked",
      "startedAt": "...",
      "completedAt": "...",
      "durationMs": 12345,
      "lockWaitMs": 230,
      "filesLocked": ["/abs/path/1", "/abs/path/2"],
      "errorCode": "AdapterSendError",
      "errorMessage": "..."
    }
  ]
}
```
- 飞书汇总卡片附「📋 postmortem: `~/.dev-brain/tasks/<taskId>/postmortem.json`」
- CLI `pnpm cli -- show <taskId>` 渲染 postmortem 摘要
- 飞书发 `postmortem <taskId>` 返 1KB 摘要（前 2 个子任务详情 + 其余子任务 ID 列表）

## CAP-BRAIN-08 task prompt 长度上限

**Given** 飞书用户输入 text 长度无上限（`feishu-events.ts:88` `description` 直接入 plan）  
**When** 整改后  
**Then**：
- `intent-parser` 与 `createPlan` 入口加硬上限 4KB
- 超限返 `MessageTooLongError` 飞书「📏 需求太长（<bytes> 字节），请拆为多条或 < 4KB」
- 同时截断 4KB 以上内容是 DoS 防护；token 实际消耗由下游 agent 决定

## L5 锚点

- L5-HARDEN-05（端到端） / L5-HARDEN-09（LRU 与 BRAIN-02 队列）
- L5-NEW-01（短 ID 碰撞测试：1 万 task 同 chatId 注入，短 ID 碰撞率 = 0）
- L5-NEW-02（retry：失败子任务单条 retry 成功，completed 子任务不动）
- L5-NEW-03（cancel：executing 子任务 5s 内收到 cancel 信号）
- L5-NEW-04（postmortem：文件存在 + 字段齐）
