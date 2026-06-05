---
demand-id: DM-20260605-002
change: production-hardening
status: archived
---

# Config Spec (Delta)

集中所有 env / 模式 / 占位 / 注入相关契约（之前散落 security CAP-SEC-01/02、cli CAP-CLI-01/04、reliability CAP-REL-05）。本 spec 是**横切关注点**。

## CAP-CONF-01 模式依赖分块

**Given** `.env.example` 当前 20+ 变量未分块  
**When** 整改后  
**Then** `.env.example` 顶部声明 4 个分块：

```bash
# === Required（必填，启动期校验）===
DEV_BRAIN_FEISHU_APP_ID=
DEV_BRAIN_FEISHU_APP_SECRET=

# === Stub 模式（默认即可跑，无需 cc-connect）===
DEV_BRAIN_ADAPTER_MODE=stub

# === Live 模式（启用 cc-connect 真实调用，需要 cc-connect daemon）===
# DEV_BRAIN_CC_CONNECT_SOCKET=/Users/fukai/.cc-connect/run/api.sock
# DEV_BRAIN_CC_PROJECT_CLAUDE=workspace-claude
# DEV_BRAIN_CC_PROJECT_CODEX=workspace-codex
# DEV_BRAIN_CC_PROJECT_CURSOR=workspace-cursor
# DEV_BRAIN_CC_SYNC=send

# === Cursor SDK 可选（未填则 cursor 走 cc-connect）===
# CURSOR_API_KEY=
```

`loadConfig` 启动期检查：`adapterMode==='live'` 时必填项缺失 → `ConfigError` 退出码 2

## CAP-CONF-02 占位值检测

**Given** 用户复制 `.env.example` 后未替换 `cli_xxx` / `xxx` / `your_*` 占位  
**When** 启动 `pnpm cli -- start`  
**Then**：
- 飞书凭证命中占位值 → stderr `[WARN] DEV_BRAIN_FEISHU_APP_ID=cli_xxx looks like a placeholder; ref https://open.feishu.cn/app`
- `pnpm cli -- start` 仍能起动但**第一条消息会 401**；不阻断启动以保留 stub 模式调试
- `CURSOR_API_KEY=your_key` 占位同样 WARN

## CAP-CONF-03 配置注入统一

**Given** 当前 `loadConfig()` 只接 `process.env`；测试被迫 mutate `process.env`（脆弱且污染全局）  
**When** 整改后  
**Then**：
```typescript
export function loadConfig(env: NodeJS.ProcessEnv = process.env): DevBrainConfig { ... }
export interface CreateDevBrainAppOptions {
  config?: DevBrainConfig;       // 完整配置覆盖
  envOverrides?: Record<string, string>;  // 局部 env 覆盖
  client?: CcConnectClient;      // DI 注入
}
export function createDevBrainApp(reporter: FeishuReporter, opts?: CreateDevBrainAppOptions): DevBrainApp { ... }
```
- CLI `dev-brain <sub> --config <path>` 接受 JSON 配置文件
- CLI `dev-brain <sub> --env KEY=VAL --env KEY2=VAL2` 多次覆盖
- 测试用 `loadConfig({ DEV_BRAIN_ADAPTER_MODE: 'stub' })` 不污染全局

## CAP-CONF-04 process.env 集中化

**Given** 当前 `src/adapters/cc-connect-client.ts:187` 等处直读 `process.env`  
**When** 整改后  
**Then**：
- 全仓 grep 0 命中 `process.env`（除 `src/config/env.ts` 与 `src/bootstrap.ts`）
- cc-connect 子进程透传的 env 子集从 `DevBrainConfig.ccDataDir` 等字段构造，不引用 `process.env`
- 未来如需新增子进程 env 字段，先在 `DevBrainConfig` 加字段再读

## CAP-CONF-05 CcConnectBridge 三条件 AND 显式告警

**Given** 当前 `enabled = ccBridgeEnabled && mode==='live' && syncMode==='send'` 三条件 AND 静默吞配置（`cc-connect-bridge.ts:65`）  
**When** 整改后  
**Then**：
- 条件不满足时启动期显式日志：
  - `ccBridgeEnabled=0` → `info: bridge disabled by config`
  - `mode=='stub'` + `bridge=1` → `info: bridge has no effect in stub mode`
  - `syncMode=='relay'` + `bridge=1` → `info: bridge has no effect in relay sync mode`
- 飞书 `probe` 子命令也展示该状态
- `doctor` 列出当前生效的 bridge 状态

## CAP-CONF-06 配置语义一致性

**Given** 当前 `DEV_BRAIN_CC_PROJECT_*` 三个 project 名与 `runtime` 字段 1:1 硬编码（`claude-code-adapter.ts:55-71`）  
**When** 整改后  
**Then**：
- `env.ts` 新增 `DEV_BRAIN_CC_PROJECT_<RUNTIME>=<projectName>` 模板（动态），运行时遍历
- 新加 runtime 只需配 env，无需改 adapter 代码
- `adapter-registry` 改用 factory pattern（详见 adapters CAP-ADPT-09）

## CAP-CONF-07 配置热重载（可选 / 留待下个 change）

`pnpm cli -- start` 监听 `SIGHUP` 重新 `loadConfig()`，不重启子进程。本 spec 仅占位，留待后续 `production-observability` 落地。

## L5 锚点

- L5-HARDEN-01/04/10
- L5-NEW-05（占位检测：`.env` 全占位值启动后 stderr 含 3 条 WARN）
- L5-NEW-06（注入统一：单测不 mutate `process.env`）
