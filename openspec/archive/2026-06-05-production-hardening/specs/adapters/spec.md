---
demand-id: DM-20260605-002
change: production-hardening
status: archived
---

# Agent Adapters Spec (Delta)

继承 `dev-brain-mvp/specs/adapters/spec.md` 的 `AgentAdapter` 接口与 Runtime 映射。本 change 增补：

## CAP-ADPT-01 Adapter 公共 API 收敛

**Given** 当前 `adapters/index.ts` 暴露 `CursorAdapter` + `CcConnectCursorAdapter` 两套实现  
**When** 整改后  
**Then**：`CcConnectCursorAdapter` 改为 `cursor-adapter.ts` 内部类，**不导出**；`index.ts` 仅暴露 `CursorAdapter`；调用方无需选择

## CAP-ADPT-02 AdapterRegistry 依赖注入

**Given** 当前 `AdapterRegistry` 构造函数隐式 `new CcConnectClient.fromConfig(config)`  
**When** 整改后  
**Then**：
```typescript
class AdapterRegistry {
  constructor(
    config: DevBrainConfig,
    client?: CcConnectClient,  // 可选，默认 fromConfig(config)
  ) { ... }
}
```
单测可注入 mock `CcConnectClient`；registry 与 brain engine 走 deps 注入（`BrainEngineDeps` 模式扩展）

## CAP-ADPT-03 cc-connect 模块合并

**Given** 当前 4 个文件粒度过细：`cc-connect-client.ts` / `cc-connect-bridge.ts` / `cc-connect-bridge-ws.ts` / `cc-connect-http.ts`  
**When** 整改后  
**Then**：
- 合并为 `cc-connect-transport.ts`（udsHttp + isSocketReachable + parseSessionsBody）
- 合并为 `cc-connect-bridge.ts`（含 WS 客户端，WS 实现 lazy import 保留 `import('ws')` 行为）
- 公共 API：`CcConnectClient`（原 client） + `CcConnectBridge`（原 bridge）保持同名
- 测试 `tests/unit/cc-connect-bridge.test.ts` 文件名 + 路径不变（内部 import 调整）

## CAP-ADPT-04 WebSocket 帧解析加固

**Given** 当前 `cc-connect-bridge-ws.ts:15-31` 自实现帧解析缺 FIN/opcode 校验  
**When** 整改后  
**Then**：
- 完整覆盖 FIN bit / RSV / opcode（continuation / text / binary / close / ping / pong）
- ping 自动 pong；close 帧主动 close 1000
- 控制帧 payload ≤125 字节；非法帧抛出 `BridgeProtocolError` 并触发 reconnect

## CAP-ADPT-05 Adapter status 区分"运行中 / 已结束"

**Given** `CursorAdapter.status()` / `CcConnectBackedAdapter.status()` 都通过 `listSessions` 查 sessionKey 是否存在判断——**完成的 session 仍报 running**（false negative）  
**When** 整改后  
**Then**：
- `cc-connect listSessions` 返回 `updated_at` 时间戳；status 内部判 `now - updatedAt < 5min` 视为 running，否则 `completed`
- 用户在飞书 / CLI 看到的 status 区分 `running` / `completed` / `unknown`
- status 接口返回类型扩展 `{ state: 'running'|'completed'|'failed'|'unknown'; lastEventAt?: string; outputPreview?: string }`

## CAP-ADPT-06 Adapter cancel 真正生效

**Given** `ClaudeCodeAdapter` / `CodexAdapter` / `CursorAdapter` 的 `cancel()` 当前全是 no-op（`claude-code-adapter.ts:38-40`、`cursor-adapter.ts:83-85`），BrainEngine 也无取消路径  
**When** 整改后  
**Then**：
- cc-connect 提供 `POST /cancel` 端点（已具备，详见 cc-connect docs），adapter 转发
- Cursor SDK 走 `session.abort()` 或类似机制
- `cancel(sessionKey)` 在 5s 内触发 agent 中断；超时标记 `failed`
- 飞书进度卡片显示「⛔ 任务已取消」

## CAP-ADPT-07 Bridge timeout 文案统一

**Given** 当前 bridge timeout 三处描述不同：stub 模式 `[bridge stub/...]`（`cc-connect-bridge.ts:80-82`）、live-disabled `bridge disabled`（第 86 行）、live-enabled `bridge reply timeout after 300000ms`（第 145 行）  
**When** 整改后  
**Then**：
- 三处统一为 `[bridge:{state}]` 前缀 + 详情：
  - `[bridge:stub] simulated reply`
  - `[bridge:disabled] cc-connect bridge is not enabled (mode=sync, see DEV_BRAIN_CC_BRIDGE)`
  - `[bridge:timeout] no reply after 300000ms; check cc-connect daemon`
- `state` 枚举：`stub` / `disabled` / `connected` / `timeout` / `error`
- 飞书汇总卡片附 bridge 状态字段

## CAP-ADPT-08 Bridge WS 断连 reconnect 反馈

**Given** 当前 WS 断连后由 HTTP 轮询接管，**无 reconnect 状态反馈**，用户感知"等了 5 分钟没回"  
**When** 整改后  
**Then**：
- WS 断连触发 `bridge_disconnected` 事件 + 立即重连（指数退避 1s/2s/5s/10s，上限 60s）
- 重连成功发 `bridge_reconnected`
- 飞书进度卡片显示当前 bridge 状态（disconnected → reconnecting → connected）
- 重连 3 次失败后切 HTTP 轮询并发 `bridge_fallback_http`

## CAP-ADPT-09 新增 runtime 接入规约

**Given** 当前新增 runtime 需同时改 `core/types.ts:1` `AGENT_RUNTIMES` + `config/env.ts` + 新 adapter 文件 + `adapter-registry.ts:13-18` 硬编码 Map + `task-planner.ts:4-6` 关键词数组——4 处硬编码耦合  
**When** 整改后  
**Then**：
- `adapter-registry` 改用 factory pattern：扫描 `adapters/<runtime>-adapter.ts` 的默认导出，自动注册
- env project 名模板 `DEV_BRAIN_CC_PROJECT_<RUNTIME>` 统一（动态遍历 process.env）
- task-planner 关键词→runtime 用 `Map<KeywordPattern, Runtime>` 集中维护
- 接新 runtime 只需 1 个新 adapter 文件 + 1 行 env 配置

## L5 锚点

- L5-HARDEN-04 / L5-BRAIN-03
- L5-NEW-07（status 区分：completed session 报 completed，非 running）
- L5-NEW-08（cancel：executing 子任务 5s 内状态变 `cancelled`）
- L5-NEW-09（新增 runtime：<8 个新文件改动即可接入）
