---
demand-id: DM-20260605-002
change: production-hardening
status: archived
---

# Security Spec (Delta)

## CAP-SEC-01 鉴权 fail-closed

**Given** `DEV_BRAIN_ALLOW_FROM` 未设置（空集）  
**When** `isSenderAllowed` 被任意 sender_open_id 调用  
**Then** 返回 `false` 并向 stderr 写入「ALLOW_FROM is empty; refusing all senders. Set `DEV_BRAIN_ALLOW_FROM=*` for dev mode.」

**Given** `DEV_BRAIN_ALLOW_FROM=*` 显式声明  
**When** `isSenderAllowed` 被任意 sender_open_id 调用  
**Then** 返回 `true`（开发模式逃生口）

**Given** `DEV_BRAIN_ALLOW_FROM=ou_aaa,ou_bbb`  
**When** sender_open_id 在集合内  
**Then** 返回 `true`；否则 `false`

## CAP-SEC-02 依赖版本固定

**Given** `package.json:36` 当前 `@cursor/sdk: "*"`  
**When** 安装执行  
**Then** `package-lock.json` 锁到 `^1.2.3`（首个稳定公开版），`pnpm install --frozen-lockfile` 在 CI 强制

## CAP-SEC-03 UDS socket 权限

**Given** dev-brain spawn cc-connect daemon  
**When** daemon 创建 `api.sock` / `bridge.sock`  
**Then** 文件 mode = `0600`，owner = dev-brain 进程 UID

## CAP-SEC-04 TOML 安全写入

**Given** `migrate-headless` 生成新 config  
**When** `workDir` 含 `\n` / `"` / `]]` 序列  
**Then** 用 `@iarna/toml` 序列化，注入序列被引号转义；非法 workDir 启动报错并退出码 2

## CAP-SEC-05 Bridge WS 鉴权握手

**Given** `cc-connect-bridge-ws` 建立 WebSocket  
**When** 客户端连接  
**Then** 发送 `Sec-WebSocket-Protocol: dev-brain-v1.<hmac(secret, ts)>.<ts>`；服务端校验时间窗口 ±60s；不通过主动 close 1008

## CAP-SEC-06 open_id 格式校验

**Given** 飞书 event 携带 `sender_id.open_id`  
**When** Gateway 解析  
**Then** zod schema 校验匹配 `^ou_[a-z0-9]{20,}$`；不匹配降级为 `unauthorized_sender`，不进入 Brain

## CAP-SEC-07 Adapter 错误脱敏

**Given** `CursorAdapter` / `CcConnectClient.send` 抛错  
**When** 错误回传飞书 `formatSummaryCard`  
**Then** 用户面只看到 `cursor sdk failed (code=xxx)`，API key / socket path / 内部栈经过 logger.error 输出，**不进入卡片 payload**

## CAP-SEC-08 HTTP 轮询回退与 WS 共享同源鉴权

**Given** `bridge.sock` 走 WS 鉴权（CAP-SEC-05）后，HTTP 轮询 `/bridge/reply` 仍走 `api.sock` 同源 socket——同未授权访问面  
**When** 整改后  
**Then**：
- `/bridge/reply` 端点同样要求 HMAC token（`X-Bridge-Auth: hmac(secret, ts)` header，ts ±60s）
- 无 token → 401 + `bridge_auth_missing` 事件
- 共享 `DEV_BRAIN_CC_BRIDGE_HMAC_SECRET` 配置（首次启动生成并提示保存）

## L5 锚点

- L5-HARDEN-10/11（CAP-SEC-04 / CAP-SEC-01 PoC 验证）
- L5-NEW-25（HTTP 轮询鉴权：未带 token 的 GET /bridge/reply 返 401）
