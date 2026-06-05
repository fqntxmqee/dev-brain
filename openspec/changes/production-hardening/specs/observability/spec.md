---
demand-id: DM-20260605-002
change: production-hardening
status: developing
---

# Observability Spec (Delta)

## CAP-OBS-01 结构化日志

**Given** 当前 5 处 `process.stderr.write` 均为 free-form 字符串  
**When** 整改后  
**Then**：
- 引入 `pino` v9
- 输出格式 `ts=2026-06-05T12:34:56.789Z level=info event=plan_created task_id=xxx chat_id=yyy ...`（key=value，避免 pino 默认 JSON 单行让 `tail` 难读）
- `DEV_BRAIN_LOG_LEVEL` 环境变量控制（debug/info/warn/error，默认 info）
- 飞书命令响应文本不变，UX 不破坏

## CAP-OBS-02 关键事件审计

| event 名 | 触发点 | 必带字段 |
|---|---|---|
| `plan_created` | `BrainEngine.createPlan` 完成 | task_id, chat_id, runtime, sub_task_count |
| `plan_approved` | `approveAndExecute` 入口 | task_id, chat_id, sender_open_id |
| `plan_cancelled` | `cancelPlan` 完成 | task_id, chat_id, sender_open_id |
| `subtask_started` | `executeSubTask` 前 | subtask_id, runtime, agent_id |
| `subtask_completed` | `executeSubTask` 成功 | subtask_id, duration_ms, output_len |
| `subtask_failed` | `executeSubTask` catch | subtask_id, error_code, error_message |
| `subtask_blocked` | FileLock 冲突 | subtask_id, file_path, holder_agent_id |
| `bridge_connected` | WS upgrade 完成 | project, session_key |
| `bridge_timeout` | Bridge 超时 | project, session_key, waited_ms |
| `sender_unauthorized` | allowFrom 拒绝 | sender_open_id, chat_id |
| `config_error` | env 校验失败 | field, value_type |

## CAP-OBS-03 基础 metrics

**Given** 当前无 metrics 出口  
**When** 整改后  
**Then**：
- 引入 `prom-client`
- `/metrics` 端点（仅 localhost 监听或 Unix Socket，与 cc-connect 一致）
- 指标：
  - `dev_brain_tasks_total{status="approved|completed|failed|blocked|cancelled"}` Counter
  - `dev_brain_task_duration_seconds{runtime}` Histogram
  - `dev_brain_subtask_duration_seconds{runtime,status}` Histogram
  - `dev_brain_pending_plans` Gauge
  - `dev_brain_bridge_waits_in_flight` Gauge
  - `dev_brain_sender_unauthorized_total` Counter

## CAP-OBS-04 Brain 状态机 trace（DEBUG 模式）

**Given** 当前 `DEV_BRAIN_DEBUG=1`（`cli.ts:47-49`）仅 dump lark-cli 原始行，**不打印 Brain 内部状态机迁移、adapter 调用、progress callback 时序**  
**When** 整改后  
**Then**：
- `DEV_BRAIN_LOG_LEVEL=debug` 时额外打印：
  - `BrainEngine.state` 迁移：`create_plan → awaiting_approval → executing → completed`
  - Adapter 调用：`adapter.send` 入参 / 出参长度 / 耗时
  - Progress callback：每个 subtask 状态变化的时间戳
  - FileLockManager：`acquire` / `release` 调用 + 冲突检测
  - 飞书 Reporter：`sendText` / `sendCard` / `updateCard` 全部入参
- 输出格式与 CAP-OBS-01 一致（key=value）
- 生产默认 `info`；debug 仅故障排查

## CAP-OBS-05 task postmortem 日志聚合

**Given** 任务执行后无系统化落盘（详见 brain CAP-BRAIN-07）  
**When** 整改后  
**Then**：
- 每个 task 结束写 `~/.dev-brain/tasks/<taskId>/postmortem.json`（结构详见 brain CAP-BRAIN-07）
- `pnpm cli -- show <taskId>` 渲染 postmortem 摘要
- 飞书发 `postmortem <taskId>` 返 1KB 摘要
- 飞书汇总卡片附「📋 postmortem: ~/.dev-brain/tasks/<taskId>/postmortem.json」
- 7 天后自动归档到 `~/.dev-brain/tasks/.archive/<taskId>.tar.zst`（按需）

## L5 锚点

- L5-HARDEN-04（doctor 输出含 metrics 端点状态）
- L5-NEW-23（DEBUG 模式：5 类事件 trace 全打印）
- L5-NEW-24（postmortem：100% 任务结束有 postmortem.json）
