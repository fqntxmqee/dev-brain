---
demand-id: DM-20260608-001
change: feishu-upgrade-v0.9.0
status: developing
---

# Feishu Gateway Spec (Delta — v0.9.0)

本文为 `dev-brain-mvp` gateway spec 的增量规范,仅描述本次新增/修改的 requirement。

## CAP-GW-04 (MODIFIED) 卡片原地刷新

**Given** 用户发送需求后 Gateway 创建计划并发送首张计划卡片
**When** Gateway 收到 `cardMessageId`(sendCard 返回值)
**Then** 后续 progress 卡片和 summary 卡片**调用 `reporter.updateCard(messageId, card)`** 而非 `sendCard`
**And** 飞书聊天记录只看到 1 张计划卡片被持续更新,不刷出 N 张

**实现要点:**
- `BrainEngine` 维护 `planMessageIds: Map<taskId, messageId>`
- Gateway `sendCard` 私有方法内部根据 planMessageId 是否存在选择 `update` 或 `send`
- `cancelPlan` / `approveAndExecute` 完成时清理 map 条目

## CAP-GW-05 (NEW) 错误态卡片

**Given** Brain 任务执行失败(子任务 failed / blocked / 整体 throw)
**When** Gateway 完成 approveAndExecute
**Then** 渲染并发送 `buildErrorCard(taskId, description, errors)` 包含:
  - task 短 ID
  - 原始需求 description
  - 失败子任务列表:`- {subTaskId} [{runtime}]: {error.slice(0,200)}`
**And** summary 文本仍发送(降级),但 error card 是主要反馈

## CAP-GW-06 (NEW) 文本自动分片

**Given** Gateway 需要回复用户文本 `text`(可能来自 /help / 汇总 / 错误信息)
**When** `Buffer.byteLength(text, 'utf8') > 16 * 1024`
**Then** `LarkCliFeishuReporter.sendText` 自动按 16KB 分片,**逐条**调用 lark-cli
**And** 每条都按 UTF-8 code point 边界切,不切碎汉字/emoji
**And** 切分时优先在 `\n` 处切,保留行结构
**And** 单条仍校验不超过 16KB(`splitTextIntoChunks` 防御性保证)

**API:**
```ts
export function splitTextIntoChunks(
  text: string,
  limitBytes?: number,  // default 16 * 1024
): ReadonlyArray<string>;
```

## CAP-GW-07 (NEW) 卡片超长降级

**Given** 卡片内容(serializeCard 输出)字节数 `> 28 * 1024`
**When** Gateway / Reporter 准备发送卡片
**Then** 触发三档降级:
  - 档 1:max 10 步骤 + max 180 字符/字段
  - 档 2:max 6 步骤 + max 120 字符/字段
  - 档 3:max 3 步骤 + max 80 字符/字段
**And** 降级后仍 > 28KB 则直接截断到 28KB 抛 `ReplyTooLongError`,由 sendText 兜底

**API:**
```ts
export function degradeCardForSize(
  card: FeishuInteractiveCard,
  maxBytes?: number,  // default 28 * 1024
): FeishuInteractiveCard;
```

## CAP-GW-08 (NEW) 401/429 错误识别与重试

**Given** LarkCliFeishuReporter 调用 lark-cli 失败
**When** stderr 包含 `"code": 99991663`(tenant_access_token 过期)或 `"code": 230020 / 230021`(rate limit)
**Then** 抛 `FeishuApiError`:
  - `code: 'AUTH_EXPIRED'` 对应 99991663
  - `code: 'RATE_LIMIT'` 对应 230020/230021
  - `code: 'OTHER'` 兜底
**And** LarkCliFeishuReporter.sendText / sendCard 包 `withTransientRetry`:
  - RATE_LIMIT:指数退避 500ms→1s→2s,加 25% jitter,最多 3 次
  - AUTH_EXPIRED / OTHER:不重试,透传错误给 Gateway

**API:**
```ts
export class FeishuApiError extends Error {
  readonly code: 'AUTH_EXPIRED' | 'RATE_LIMIT' | 'OTHER';
  readonly feishuCode: number;
  readonly stderr: string;
}

export function classifyLarkCliError(stderr: string): FeishuApiError | undefined;
export function withTransientRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; baseMs?: number; jitterRatio?: number },
): Promise<T>;
```
