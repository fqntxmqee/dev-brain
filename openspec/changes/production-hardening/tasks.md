---
demand-id: DM-20260605-002
title: Dev Brain 生产加固 — 任务
created: 2026-06-05
---

# Dev Brain 生产加固 — 任务

## P0 救火（0.5d）

| ID | 任务 | 关联规范 | 状态 |
|----|------|---------|------|
| T-01 | 修 `pnpm typecheck` 12 处错误（`codex-adapter.ts` 删除、`cc-connect-bridge-ws.ts` 加 undefined 守卫、`brain-engine.ts:116` / `task-planner.ts:36` 改 spread、`cli.ts:44` 抽 `FeishuReporter` 接口） | CAP-QUAL-01 | todo |
| T-02 | 修 `src/brain/task-planner.ts:21` 三元恒为 `'codex'` bug | CAP-QUAL-01 / CAP-BRAIN-01 | todo |
| T-03 | 修 `src/cli/migrate-headless.ts:101-105` TOML 模板字符串注入（用 `@iarna/toml`） | CAP-SEC-04 | todo |
| T-04 | 扩错误类型（详见 [specs/errors/spec.md CAP-ERR-01） | CAP-ERR-01 | todo |
| 前置 | T-05 (toErrorMessage 先完成) | - |
| 输入 | `grep "catch.*unknown" src/` | - |
| 输出 | 8 个错误类 + `src/governance/errors.test.ts` | - |
| 验收 | `pnpm test` 通过 + L5-NEW-20 验证 | L5-NEW-20 |
| T-05 | 统一 toErrorMessage + cause 链（详见 [specs/errors/spec.md CAP-ERR-02） | CAP-ERR-02 | todo |
| 前置 | T-04 (错误类存在) | - |
| 输入 | `grep "catch (error)" src/**/*.ts` | - |
| 输出 | `src/utils/errors.ts` 新增 toErrorMessage + asBrainError | - |
| 验收 | L5-NEW-20 grep 验证 | L5-NEW-20 |

## P1 护城河（1.5d）

| ID | 任务 | 关联规范 | 状态 |
|----|------|---------|------|
| T-06 | `isSenderAllowed` 反转 fail-closed，`.env.example` 默认 `DEV_BRAIN_ALLOW_FROM=*` | CAP-SEC-01 | todo |
| T-07 | `package.json`: `@cursor/sdk` 锁版本 `^1.2.3`，补 integrity | CAP-SEC-02 | todo |
| T-08 | 加 `eslint.config.js` (flat config) + `.prettierrc.json` + `pnpm lint` / `pnpm format` 跑通 | CAP-QUAL-02 | todo |
| T-09 | 加 `.github/workflows/ci.yml`：typecheck + lint + test + build | CAP-QUAL-01 | todo |
| T-10 | 加 `.husky/pre-commit` + `lefthook.yml`，串 typecheck + lint + test | CAP-QUAL-02 | todo |
| T-11 | `src/cli/cli.ts` `start` 子命令加 `feishu_credentials` / `cc_connect_socket` 预检 | CAP-CLI-01 | todo |
| T-12 | 修 `src/cli/cli.ts:145` `migrate-headless` 退出码反（dry-run 成功返 0） | CAP-CLI-01 | todo |
| T-13 | `vitest.config.ts` 加 `coverage.thresholds: { lines: 80, branches: 80, statements: 80, functions: 80 }` | CAP-QUAL-03 | todo |
| T-14 | 删死代码：`codex-adapter.ts`、重复 `LockMode` 收敛到 `governance/types.ts`、`AGENT_RUNTIMES` / `TASK_PHASES` / `LOCK_MODES` 0 引用清理 | CAP-QUAL-05 | todo |
| T-15 | `feishu-events.ts:96` `open_id` 加 zod 格式校验（`^ou_[a-z0-9]{20,}$`） | CAP-SEC-06 | todo |
| T-16 | cc-connect daemon 启动前 `chmod 0600` bridge.sock / api.sock（spawn hook） | CAP-SEC-03 | todo |
| T-17 | WebSocket 帧解析器补 FIN/opcode/ping-pong/close 帧分支 | CAP-ADPT-04 | todo |

## P2 健壮性（2d）

| ID | 任务 | 关联规范 | 状态 |
|----|------|---------|------|
| T-18 | 补 5 个 live-mode 集成测试：`live-cc-connect` / `live-cursor` / `lark-cli-reporter` / `brain-engine-approval` / `file-lock-cross-process` | CAP-QUAL-04 | todo |
| T-19 | `BrainEngine` 状态持久化到 `~/.dev-brain/state.json`（atomic write + debounce + schemaVersion） | CAP-REL-02 | todo |
| T-20 | `runFeishuEventLoop` 注册 SIGTERM/SIGINT 处理器：`child.kill()` + `rl.close()` + 等 in-flight | CAP-REL-01 | todo |
| T-21 | 引入 `pino` 结构化日志，定义 `DEV_BRAIN_LOG_LEVEL`，替换 5 处 stderr.write | CAP-OBS-01 | todo |
| T-22 | 关键事件（plan_created / plan_approved / subtask_* / bridge_* / sender_unauthorized）补 audit 日志 | CAP-OBS-02 | todo |
| T-23 | `src/config/env.ts` 数值字段用 zod 校验，NaN / 负数启动报错 | CAP-REL-05 | todo |
| T-24 | `BrainEngine.pendingByChat` LRU（`Map` + `maxSize`）或 `createdAt` TTL | CAP-REL-06 | todo |
| T-25 | `FileLockManager.expireStaleLocks` 同时清 `readCounts` | CAP-REL-03 | todo |
| T-26 | Cursor SDK 错误 catch `ERR_MODULE_NOT_FOUND`（替代字符串嗅探） | CAP-CLI-04 | todo |
| T-27 | 飞书回复 / 错误信息脱敏（API key 片段、socketPath） | CAP-SEC-07 | todo |

## P3 生产就绪（2d）

| ID | 任务 | 关联规范 | 状态 |
|----|------|---------|------|
| T-28 | 引入 `proper-lockfile`，`FileLockManager` 改用 flock（opt-in `--multi-instance`） | CAP-REL-03 | todo |
| T-29 | cc-connect 4 文件合并：`cc-connect-transport.ts` + `cc-connect-bridge.ts`（含 lazy WS） | CAP-ADPT-03 | todo |
| T-30 | `AdapterRegistry` 构造函数接可选 `client?: CcConnectClient` | CAP-ADPT-02 | todo |
| T-31 | 隐藏 `CcConnectCursorAdapter`，`adapters/index.ts` 仅暴露 `CursorAdapter` | CAP-ADPT-01 | todo |
| T-32 | Gateway 拆分为 `common/` + `feishu/`，定义 `MessageGateway` / `MessageCard` / `OutboundReporter` 公共接口 | CAP-GW-01 | todo |
| T-33 | 飞书 `FeishuInboundMessage` 改名 `InboundMessage`，加平台无关字段 | CAP-GW-01 | todo |
| T-34 | 飞书 event loop 加 messageId 去重（5 分钟滑动窗口） | CAP-REL-04 | todo |
| T-35 | `migrate-headless --undo <backup>` 子命令 | CAP-CLI-03 | todo |
| T-36 | Bridge WebSocket 鉴权握手（HMAC over Sec-WebSocket-Protocol） | CAP-SEC-05 | todo |
| T-37 | 加基础 metrics：任务计数 / 成功率 / p50p95 / runtime 分布（pino + prom-client） | CAP-OBS-03 | todo |
| T-38 | 加 `deploy/dev-brain.service` (systemd) + `Dockerfile` | （运维交付） | todo |

## P4 重构（1-2d）

| ID | 任务 | 关联规范 | 状态 |
|----|------|---------|------|
| T-39 | `task-planner.ts` 关键词→runtime 用集中 Map 维护 | CAP-ADPT-09 | todo |
| T-40 | `createDevBrainApp` 增加 `config?: DevBrainConfig` 形参，CLI 接受 `--config <path>` / `--env KEY=VAL` | CAP-CONF-03 | todo |
| T-41 | `process.env` 直读统一收敛到 `env.ts`（去掉 `cc-connect-client.ts:187` 等直读） | CAP-CONF-04 / CAP-REL-09 | todo |
| T-42 | `feishu-gateway.ts` / `feishu-reporter.ts` 日志 ANSI 转义 | （L1） | todo |
| T-43 | `feishu-reporter.ts` `reply.text` 长度上限 16KB（防 ARG_MAX） | （L3） | todo |
| T-44 | `migrate-headless` 备份命名 rotate（保留最近 5 份） | （L4） | todo |
| T-45 | 魔法数字收口（`MAX_DESC_LEN` / `MAX_OUTPUT_LEN` 常量） | CAP-QUAL-09 | todo |
| T-46 | 升级 ESLint 9 / TypeScript 5.6 / Vitest 3（稳定版） | CAP-QUAL-07 | todo |
| T-47 | `design.md` 与代码命名对齐（`planTask` → `createPlan` 等） | CAP-REL-12 | todo |
| T-48 | `tests/` 目录加 `tsconfig.test.json` 纳入 typecheck | CAP-QUAL-06 | todo |

## P5 一致性 / 可用性补强（基于二轮 review 1-2d）

| ID | 任务 | 关联规范 | 状态 |
|----|------|---------|------|
| T-49 | 修 `task-planner.ts:21` 三元恒为 `'codex'` | CAP-BRAIN-01 | todo |
| T-50 | CLI `plan` 订阅 `onProgress` 打印进度行 | CAP-GW-02 | todo |
| T-51 | `intent-parser` 支持 mention 前缀 + 未知指令回 `/help` | CAP-GW-03 | todo |
| T-52 | 飞书 Reporter 抽 `updateCard(messageId, card)` + 进度卡片改 update | CAP-GW-04 | todo |
| T-53 | 文本 `/approve <taskId>` 与卡片回调走同入口 | CAP-GW-05 | todo |
| T-54 | `formatError(err, audience)` 统一文案生成器 | CAP-ERR-03 / CAP-GW-06 | todo |
| T-55 | `redactPath(path)` 工具 + 飞书/CLI 自动脱敏 | CAP-ERR-04 | todo |
| T-56 | `Adapter.status` 区分 running/completed | CAP-ADPT-05 | todo |
| T-57 | `Adapter.cancel` 真正生效（cc-connect POST /cancel） | CAP-ADPT-06 / CAP-BRAIN-06 | todo |
| T-58 | Bridge timeout 文案统一 `[bridge:state]` 前缀 | CAP-ADPT-07 | todo |
| T-59 | Bridge WS 断连指数退避重连 + 状态卡片反馈 | CAP-ADPT-08 | todo |
| T-60 | AdapterRegistry factory pattern + 关键词 Map | CAP-ADPT-09 | todo |
| T-61 | pendingByChat 覆盖告警 + 等待队列（上限 3） | CAP-BRAIN-02 | todo |
| T-62 | 全量子任务输出落 `~/.dev-brain/tasks/<taskId>/<subTaskId>.txt` | CAP-BRAIN-03 / CAP-OBS-05 | todo |
| T-63 | 短 ID 改 12 字符 + sessionKey 统一模板 | CAP-BRAIN-04 | todo |
| T-64 | `retry <taskId>` 子任务重跑（保留 completed） | CAP-BRAIN-05 | todo |
| T-65 | postmortem.json 落盘 + 飞书/CLI 渲染 | CAP-BRAIN-07 / CAP-OBS-05 | todo |
| T-66 | message text 4KB 硬上限 → MessageTooLongError | CAP-BRAIN-08 / CAP-REL-08 | todo |
| T-67 | `pnpm cli -- show` / `retry` / `list` 子命令 | CAP-CLI-07 / CAP-BRAIN-05/07 | todo |
| T-68 | doctor 失败 next-step 提示 | CAP-CLI-05 | todo |
| T-69 | plan 输出 DAG 可视化（ASCII 连接符） | CAP-CLI-06 | todo |
| T-70 | `.env.example` 模式分块 + loadConfig 必填校验 | CAP-CONF-01 / CAP-CLI-09 | todo |
| T-71 | loadConfig 占位值检测 + `start --strict` flag | CAP-CLI-08 / CAP-CONF-02 | todo |
| T-72 | cc-connect daemon 不可达告警 + auto-stub flag | CAP-REL-07 | todo |
| T-73 | `migrate --apply` 原子化（write tmp + rename） | CAP-CLI-11 | todo |
| T-74 | 凭证过期诊断提示（飞书卡片 + 链接） | CAP-CLI-12 | todo |
| T-75 | `help-exit-codes` 子命令 + --help 引用退出码表 | CAP-CLI-13 | todo |
| T-76 | `migrate --apply` 成功消息附回滚命令 | CAP-CLI-14 | todo |
| T-77 | cc-connect TOML `schema_version` 注入 + doctor 校验 | CAP-REL-11 | todo |
| T-78 | expireStaleLocks 同时清 readCounts | CAP-REL-10 | todo |

## L5 锚点（验收）

### 既有（PASS/FAIL 验证）

| ID | 验证项 | 关联规范 |
|---|---|---|
| L5-HARDEN-01 | `pnpm typecheck` 0 错误 | CAP-QUAL-01 / CAP-QUAL-06 |
| L5-HARDEN-02 | `pnpm lint` 0 错误 | CAP-QUAL-02 |
| L5-HARDEN-03 | `pnpm test --coverage` 行 + 分支 ≥ 80% | CAP-QUAL-03 |
| L5-HARDEN-04 | `pnpm cli -- doctor` 全绿（live 环境） | CAP-CLI-01 / CAP-CONF-01 |
| L5-HARDEN-05 | 飞书 `/approve` → 进度卡片 → 汇总卡片 全链路 | CAP-REL-01 / CAP-REL-02 |
| L5-HARDEN-06 | 5 个 review agent 随机抽 5 条历史发现 100% 命中修复 | （回归） |
| L5-HARDEN-07 | SIGTERM 发送后 5s 内进程退出，fd 全部释放 | CAP-REL-01 |
| L5-HARDEN-08 | 多 dev-brain 实例同时 acquire 同一 filePath 互斥 | CAP-REL-03 |
| L5-HARDEN-09 | 100k 条垃圾消息注入，pending 不超过 LRU 上限 | CAP-REL-06 |
| L5-HARDEN-10 | TOML 注入 PoC 不再可执行 | CAP-SEC-04 |
| L5-HARDEN-11 | `ALLOW_FROM=` 默认启动后 `/approve` 被拒 | CAP-SEC-01 |
| L5-HARDEN-12 | daemon 重启后 `pendingByChat` 恢复 | CAP-REL-02 |

### 新增（基于二轮 review）

| ID | 验证项 | 关联规范 |
|---|---|---|
| L5-NEW-01 | 短 ID 碰撞测试：1 万 task 同 chatId 注入，碰撞率 = 0 | CAP-BRAIN-04 |
| L5-NEW-02 | retry：失败子任务单条 retry 成功，completed 子任务不动 | CAP-BRAIN-05 |
| L5-NEW-03 | cancel：executing 子任务 5s 内收到 cancel 信号 | CAP-BRAIN-06 |
| L5-NEW-04 | postmortem：文件存在 + 字段齐 | CAP-BRAIN-07 |
| L5-NEW-05 | 占位检测：`.env` 全占位值启动后 stderr 含 3 条 WARN | CAP-CONF-02 |
| L5-NEW-06 | 注入统一：单测不 mutate `process.env` | CAP-CONF-03 |
| L5-NEW-07 | status 区分：completed session 报 completed，非 running | CAP-ADPT-05 |
| L5-NEW-08 | cancel：executing 子任务 5s 内状态变 `cancelled` | CAP-ADPT-06 |
| L5-NEW-09 | 新增 runtime：<8 个新文件改动即可接入 | CAP-ADPT-09 |
| L5-NEW-10 | @bot /approve 命中 approve intent | CAP-GW-03 |
| L5-NEW-11 | 进度卡片：1 任务 1 卡片，连续 update 3 次 | CAP-GW-04 |
| L5-NEW-12 | doctor 失败 next-step：6 个常见 check 全部命中提示 | CAP-CLI-05 |
| L5-NEW-13 | show：postmortem 渲染 | CAP-CLI-07 |
| L5-NEW-14 | migrate --apply 原子：模拟写失败不污染原文件 | CAP-CLI-11 |
| L5-NEW-15 | 凭证过期：stderr / 飞书卡片含修复步骤 | CAP-CLI-12 |
| L5-NEW-16 | cc-connect 挂：fail-fast 模式失败 + auto-stub 模式走 stub | CAP-REL-07 |
| L5-NEW-17 | prompt 长度上限：5KB 输入返 MessageTooLongError | CAP-REL-08 |
| L5-NEW-18 | schema_version：cc-connect 1.x 启动时 doctor 显示 schema 1.0 已知 | CAP-REL-11 |
| L5-NEW-19 | tests typecheck：`pnpm typecheck` 含 tests 后 0 错误 | CAP-QUAL-06 |
| L5-NEW-20 | toErrorMessage：grep `instanceof Error` 全仓只有 utils 命中 | CAP-QUAL-08 |
| L5-NEW-21 | 错误文案：7 类 error 在飞书 / CLI / 日志三处文案完全一致 | CAP-ERR-03 |
| L5-NEW-22 | 路径脱敏：$HOME 替换为 ~，单测覆盖 | CAP-ERR-04 |
| L5-NEW-23 | DEBUG 模式：5 类事件 trace 全打印 | CAP-OBS-04 |
| L5-NEW-24 | postmortem：100% 任务结束有 postmortem.json | CAP-OBS-05 |
| L5-NEW-25 | HTTP 轮询鉴权：未带 token 的 GET /bridge/reply 返 401 | CAP-SEC-08 |
