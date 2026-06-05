---
demand-id: DM-20260605-002
title: Dev Brain 生产加固 — 设计决策
created: 2026-06-05
---

# 设计 — Dev Brain 生产加固

## 1. 阶段切分（P0 → P4 路线图）

```
P0 救火 (0.5d)        — 修 typecheck 12 处 / task-planner 三元 / TOML 注入 / 错误类型
P1 护城河 (1.5d)       — 鉴权反转 / CI 串 typecheck / eslint+prettier+husky / 锁依赖版本 / UDS 权限
P2 健壮性 (2d)         — 覆盖率 63→80% / 状态持久化 / SIGTERM / 结构化日志
P3 生产就绪 (2d)       — flock 跨进程锁 / cc-connect 文件合并 / AdapterRegistry DI / Gateway 平台抽象
P4 重构 (1-2d)         — LRU / messageId 去重 / env zod / --undo / magic number 常量化
```

每个 P 阶段结束都跑一次 `pnpm cli -- plan "smoke"` 端到端 + `pnpm test --coverage` 不降级。

## 2. 关键设计决策

### 2.1 鉴权反转 fail-closed（CAP-SEC-01）

**变更**：`src/config/env.ts:83-88`

```typescript
// 旧
if (config.allowFrom.size === 0) return true;
// 新
if (config.allowFrom.size === 0) {
  process.stderr.write('[dev-brain] DEV_BRAIN_ALLOW_FROM is empty; refusing all senders. Set DEV_BRAIN_ALLOW_FROM=* for dev mode.\n');
  return false;
}
```

**理由**：零配置默认应是「拒绝」而非「放行」；开发模式由显式 `=*` 表明意图。
**回滚路径**：将判定反转为 `true` 并加 warn；保留接口签名。

### 2.2 错误类型体系（CAP-ERR-01）

**新增**（`src/governance/errors.ts`）：
- `AdapterSendError extends Error` — adapter send 失败
- `TaskNotFoundError extends Error` — approve/cancel 找不到 pending 计划
- `DependencyCycleError extends Error` — DAG 有环
- `UnauthorizedSenderError extends Error` — open_id 不在 allowFrom
- `ConfigError extends Error` — 启动期 env 校验失败
- `BridgeTimeoutError extends Error` — Bridge 异步回复超时
- `LockConflictError extends Error` — 已存在，扩展 `requesterAgentId` 字段使用

**约束**：
- adapter 边界保持 `Result<{ok, output?, error?}>` 风格（向后兼容）
- brain 内部统一 throw 自定义类
- `catch (error: unknown)` 全部走 `error instanceof Error ? error.message : String(error)` + `cause: error`

### 2.3 状态持久化（CAP-REL-02）

**存储**：`~/.dev-brain/state.json`
**结构**：
```json
{
  "schemaVersion": 1,
  "pendingByChat": { "<chatId>": { "taskId", "description", "subTasks", "createdAt" } },
  "completed": { "<taskId>": { "...": "..." } }
}
```

**写入策略**：
- atomic write：`writeFile(tmp)` + `rename(tmp, real)`
- debounce 5s（避免每次 setState 都写盘）
- fsync 强制落盘（防 OOM 后丢失）

**不持久化**：
- `TaskOrchestrator.tasks` 中 active 状态（启动后发飞书"被中断"消息）
- `FileLockManager`（受 C-5 flock 接管）
- `Bridge` 收集中的 WebSocket 状态（连接断开即视为 timeout）

**版本兼容**：`schemaVersion !== 1` 时拒绝启动并提示备份迁移。

### 2.4 跨进程文件锁（CAP-REL-03）

**方案 A（推荐）**：`flock(LOCK_EX | LOCK_NB)` 走 `proper-lockfile` 库，自动 PID 续期。
**方案 B**：`fcntl(F_SETLK)` 自实现，规避依赖。
**选择 A**：`proper-lockfile` 已被 cc-connect / ESLint 等大型项目采用，行为可预期。

**锁粒度**：
- 锁名 = `dev-brain:filelock:<absPath>`
- 锁目录 `~/.dev-brain/locks/`
- 写锁与读锁对应原 `FileLockManager` 语义

**向后兼容**：`FileLockManager` 公开接口不变；实现细节切换；多实例下需要 `--multi-instance` flag 才启用 flock，单实例继续走内存 Map 以保持 P99 性能。

### 2.5 结构化日志（CAP-OBS-01）

**库**：`pino`（零依赖、生产级）
**格式**：
```
ts=2026-06-05T12:34:56.789Z level=info event=plan_created task_id=xxx chat_id=yyy runtime=claude-code
```

**控制**：
- `DEV_BRAIN_LOG_LEVEL=info`（默认）/ `debug` / `warn` / `error`
- 飞书命令响应仍走文本，不动现有 UX
- stderr 输出 key=value 格式（避免 pino 引入的 JSON 单行让 `tail` 难读）

**关键事件**（必须打）：
- `plan_created` / `plan_approved` / `plan_cancelled`
- `subtask_started` / `subtask_completed` / `subtask_failed` / `subtask_blocked`
- `bridge_connected` / `bridge_timeout` / `bridge_disconnected`
- `sender_unauthorized` / `config_error`

### 2.6 cc-connect 模块合并（CAP-ADPT-03）

**合并**：
- `cc-connect-http.ts` + `cc-connect-client.ts` → `cc-connect-transport.ts`
- `cc-connect-bridge.ts` + `cc-connect-bridge-ws.ts` → `cc-connect-bridge.ts`（WS 客户端 lazy import）

**保留**：
- `cc-connect-bridge.ts:99` 的 lazy import（避免未用 WS 时拉依赖）

**测试**：现有 `tests/unit/cc-connect-bridge.test.ts` 路径不变，文件名微调。

### 2.7 Gateway 平台抽象（CAP-GW-01）

**目标**：让 Slack / 钉钉能复用 70% 逻辑

**新结构**：
```
src/gateway/
├── common/
│   ├── message-gateway.ts      # interface MessageGateway
│   ├── message-card.ts         # interface MessageCard
│   ├── outbound-reporter.ts    # interface OutboundReporter
│   └── intent-dispatcher.ts    # 平台无关
├── feishu/
│   ├── index.ts                # FeishuGateway implements MessageGateway
│   ├── feishu-events.ts
│   ├── feishu-cards.ts
│   ├── feishu-gateway.ts
│   └── feishu-reporter.ts
└── index.ts
```

**实施成本**：3-5 天，故拆为单独阶段 P3 末尾；不阻塞 P0-P2。

### 2.8 测试覆盖率门槛（CAP-QUAL-03）

**`vitest.config.ts` 新增**：
```typescript
coverage: {
  provider: 'v8',
  thresholds: { lines: 80, branches: 80, statements: 80, functions: 80 },
  exclude: ['**/*.test.ts', 'src/gateway/feishu-cards.ts' /* 卡片 JSON 序列化 */],
}
```

**必须补的测试**（P2 阶段）：
1. `tests/integration/live-cc-connect.test.ts` — mock UDS，验证 HTTP /send + Bridge WS + HTTP 轮询回退
2. `tests/integration/live-cursor.test.ts` — mock `@cursor/sdk`，验证 SDK 缺失/成功/失败三态
3. `tests/unit/lark-cli-reporter.test.ts` — 用 child_process mock 验证 lark-cli 命令行参数
4. `tests/unit/brain-engine-approval.test.ts` — 补充审批门控正向/反向用例
5. `tests/unit/file-lock-cross-process.test.ts` — spawn child 验证 flock 互斥

### 2.9 CI 工作流

**`.github/workflows/ci.yml`**：
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test --coverage
      - run: pnpm build
```

**本地钩子**（`lefthook.yml` 或 `.husky/`）：
- pre-commit：`pnpm typecheck && pnpm lint --fix && pnpm test --run`
- pre-push：完整 `pnpm test --coverage`

## 3. 兼容性矩阵

| 现有行为 | 新行为 | 兼容性 |
|---|---|---|
| `pnpm cli -- plan` stub 模式 | 不变 | ✅ |
| `pnpm cli -- start` 默认 fail-open | 默认 fail-closed，`.env` 需显式 `ALLOW_FROM=*` | ⚠️ 破坏性，需 README 提示 |
| `pnpm cli -- migrate-headless --check` | 退出码：dry-run 成功返 0 | ✅ 仅退出码修正 |
| `tsconfig.json exclude: ['tests']` | `tsconfig.test.json` 纳入 | ✅ 增量 |
| AdapterRegistry 隐式 `fromConfig` | 构造器接可选 `client?` | ✅ 向后兼容 |
| 文件锁内存 Map | flock 跨进程（opt-in） | ✅ 默认行为不变 |

## 4. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| typecheck 修复引入新错误 | 中 | 低 | 修一处跑一次 tsc |
| 鉴权反转导致本地 demo 失败 | 高 | 低 | README 顶部红字提示 + `.env.example` 默认 `=*` |
| flock 引入依赖后 Windows 失效 | 中 | 中 | dev-brain 已声明 macOS/Linux only（见 README 要求），不兼容 Windows 可接受 |
| 状态持久化 schema 变化 | 低 | 中 | `schemaVersion` 字段 + 拒绝启动 + 迁移脚本 |
| 覆盖率门槛误伤重构 | 中 | 中 | 排除项集中维护（`vitest.config.ts` `coverage.exclude`） |
| AdapterRegistry DI 重构影响 Phase 2-4 测试 | 中 | 高 | DI 形参可选，先补测试再改实现 |
| 飞书 `update_card` API 与 open platform 行为差异 | 中 | 中 | 卡片 callback token + messageId 双重保险，回退到 `sendCard` 兜底 |
| cc-connect 暂未提供 `POST /cancel` 端点 | 高 | 中 | BRAIN-06 落地先打「⛔ 任务取消中（5s 超时）」过渡，详见 proposal §6 后续 |
| 短 ID 12 字符兼容飞书卡片 display 长度 | 低 | 低 | 飞书卡片字段上限 100 字符，12 字符短 ID + emoji 仍有余量 |
| 进度 update 卡片触发飞书频控（默认 5 QPS / 群） | 中 | 中 | progress 节流：同 task 同一卡片 30s 至少 1 次 update |

## 5. 二轮 review 增补设计决策

> 2026-06-05 第 5 个 agent 专攻**功能一致性 + 可用性**，产出 14 项一致性 + 21 项可用性结论。本节增补对应设计决策（不重复原 §2 内容）。

### 5.1 CLI / 飞书进度对称（CAP-GW-02 / CAP-GW-04）

**目标**：`InMemoryFeishuReporter` 与 `LarkCliFeishuReporter` 走完全同构的进度反馈路径。

**实现**：
- `FeishuReporter` 接口扩展 `onProgress(handler: (event: ProgressEvent) => void): void`
- `InMemoryFeishuReporter` 把 progress event 推给 CLI 终端渲染
- `LarkCliFeishuReporter` 首次 progress 发 `sendCard` 记下 `messageId`，后续 `updateCard(messageId, card)` 走飞书 open api
- 飞书端用 `[bridge:state]` 字段，CLI 端用 `[state]` 前缀 —— 同源不同表达

### 5.2 短 ID 12 字符 + sessionKey 统一模板（CAP-BRAIN-04）

**旧**：
- taskId 全长 36 字符，CLI/卡片 `.slice(0, 8)` 展示
- sessionKey 构造 3 种：`${taskId}:${subTask.id}` / `dev-brain:${project}:default` / `dev-brain:probe:${Date.now()}`

**新**：
- 短 ID 统一 12 字符
- sessionKey 统一模板 `dev-brain:task:<taskId-12>:subtask:<subTaskId-12>`
- `probe` 与 `plan` 走同一会话体系，不再是临时 `dev-brain:probe:...`
- 12 字符 + 全链路 grep-friendly

### 5.3 Adapter cancel 协议（CAP-ADPT-06 / CAP-BRAIN-06）

**目标**：`/cancel <taskId>` 5s 内真正中断正在执行的子任务。

**协议**：
- `cc-connect` 端：新增 `POST /cancel` 接受 `{ project, sessionKey }`，5s 内 kill agent 子进程（cc-connect 1.x 升级，参见 proposal §6 后续）
- `dev-brain` 端：`Adapter.cancel(sessionKey)` 同步发 POST /cancel，等 5s 返回；超时则标记 `failed` 并 stderr 告警
- 飞书进度卡片：cancel 信号发出后立即显示「⛔ 任务取消中…」；5s 后变「⛔ 任务已取消」或「❌ 取消超时」

**降级**：cc-connect 老版本不提供 `/cancel`，则走"软取消"（标记 plan cancelled，agent 自然跑完不再汇报结果）—— 飞书文案明示「⏳ agent 仍在后台运行，完成后将丢弃」

### 5.4 错误文案生成器（CAP-ERR-03 / CAP-GW-06）

```typescript
type Audience = 'feishu' | 'cli' | 'log';

function formatError(err: unknown, audience: Audience): string {
  const e = err instanceof DevBrainError ? err : new AdapterSendError(toErrorMessage(err), { cause: err });
  const emoji = ERROR_EMOJI[e.code] ?? '❌';
  const msg = e.message;
  switch (audience) {
    case 'feishu': return `${emoji} [${e.code}] ${msg}`;
    case 'cli':    return `${emoji} [${e.code}] ${msg}${nextStep(e.code) ? '\n💡 ' + nextStep(e.code) : ''}`;
    case 'log':    return `event=error code=${e.code} msg="${msg}" cause="${e.cause}"`;
  }
}
```

**emoji 映射**：见 spec 表（`⛔ 鉴权` / `🔑 配置` / `🔍 未找到` / `⚠️🔒 冲突` / `⏱ 超时` / `🛑 协议` / `❌ 通用`）

### 5.5 进度更新节流（CAP-GW-04 实施细节）

**频控策略**：
- 同 task 同一卡片 30s 内最多 update 1 次（避免飞书频控 5 QPS）
- 状态从 `executing` → `completed` / `failed` 立即 update（用户感知关键）
- 长任务首次 sendCard 100ms 内发；后续 update 节流

**降级**：飞书频控 429 → 回退到 `sendCard`（接受刷屏），并 stderr 告警

### 5.6 全量输出持久化（CAP-BRAIN-03 / CAP-BRAIN-07）

**目录结构**：
```
~/.dev-brain/
├── state.json                    # 任务状态
├── locks/                        # 跨进程文件锁（CAP-REL-03）
└── tasks/
    ├── <taskId>/
    │   ├── <subTaskId>.txt       # 全量输出（CAP-BRAIN-03）
    │   ├── postmortem.json       # postmortem 聚合（CAP-BRAIN-07）
    │   └── .archive/             # 7 天后归档
    └── .archive/                 # 整 task 归档
```

**清理策略**：
- 任务完成 7 天后整 task 移到 `.archive/`（保留 30 天）
- 总占用 > 1GB 时 LRU 驱逐最旧

### 5.7 一致性 / 可用性 review 落地的工程原则

1. **对称优先**：飞书与 CLI 同源行为必须同构
2. **降级可观察**：auto-stub / update 失败 / 占位值 / 凭证过期 —— 任何降级都要 stderr + 飞书文案明示
3. **ID 全链路 grep 友好**：12 字符短 ID + 统一 sessionKey 模板
4. **错误三出口一致**：飞书 / CLI / 日志 同一文案生成器
5. **生命周期完整**：show / retry / list / cancel / postmortem — 缺一不可
