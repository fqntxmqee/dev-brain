# feishu-upgrade-v0.9.0 Tasks

## Phase 1: 卡片交互闭环 (CAP-GW-04 / CAP-GW-05)

### T-90: planMessageId 追踪
- [ ] `BrainEngine` 新增 `planMessageIds: Map<taskId, messageId>` 字段
- [ ] `getPlanMessageId(taskId)` / `setPlanMessageId(taskId, messageId)` 公开方法
- [ ] `cancelPlan` / `approveAndExecute` 完成时清理对应条目
- [ ] 单测:`set/get/clear` 行为

### T-91: Gateway sendCard 改为 updateCard
- [ ] Gateway `sendCard` 私有方法:优先尝试 `reporter.updateCard(planMessageId, card)`,fallback `reporter.sendCard`
- [ ] `handleMessage` 路径:create_task 后把返回的 messageId 存进 `planMessageId`;progress 回调和 summary 都走 updateCard
- [ ] `handleCardAction` 路径:approve 后 progress 回调 + summary 都走 updateCard(若 planMessageId 存在)
- [ ] 单测:InMemory reporter 记录 `updates` 而非 `cards`

### T-92: buildErrorCard + 失败态卡片
- [ ] 新增 `buildErrorCard(taskId, description, errors)` 渲染器
- [ ] Gateway `handleCardAction` approve 失败 / 部分失败分支走 error card 而非纯文本
- [ ] 单测:error card 包含错误子任务列表

## Phase 2: 发送链路稳健化 (CAP-GW-06 / CAP-GW-07)

### T-93: splitTextIntoChunks
- [ ] 新增 `src/gateway/text-splitter.ts`,导出 `splitTextIntoChunks(text, limitBytes=16*1024)`
- [ ] 算法:UTF-8 安全切片(不切碎 code point),按换行优先切分(保留行结构)
- [ ] 单测:空 / 刚好 16KB / 超 16KB / 中文字符边界 / 长行无换行

### T-94: LarkCliFeishuReporter.sendText 自动分片
- [ ] `sendText` 检测到 `ReplyTooLongError` 时,改为 `splitTextIntoChunks` 后逐条 send
- [ ] InMemory reporter 同步实现分片语义
- [ ] 单测:长文本被切为 N 条 send

### T-95: degradeCardForSize 三档降级
- [ ] 新增 `src/gateway/card-degrader.ts`,导出 `degradeCardForSize(card, maxBytes=28*1024)`
- [ ] 三档:`MAX_STEPS=10, MAX_FIELD=180` → `6, 120` → `3, 80`
- [ ] 触发条件:序列化后 `JSON.stringify(card).length > maxBytes`
- [ ] 单测:三档降级后字节数 + 步骤数

### T-96: LarkCliFeishuReporter 透传 401/429 错误
- [ ] `spawnLarkCli` 检测 stderr 中 `code: 99991663 / 99991668 / 230020` 等关键码
- [ ] 新增 `FeishuApiError` 类,带 `code: 'AUTH_EXPIRED' | 'RATE_LIMIT' | 'OTHER'`
- [ ] 单测:mock spawn 让 stderr 含 `"code": 99991663` → 抛 `FeishuApiError`

### T-97: Gateway 401/429 简单重试
- [ ] LarkCliFeishuReporter.sendText / sendCard 包一层 `withRetry(fn, { maxRetries: 3, baseMs: 500 })`
- [ ] 仅对 `RATE_LIMIT` 重试(指数退避 + 25% jitter,参考 cc-connect `withTransientRetry`)
- [ ] `AUTH_EXPIRED` 不重试(透传,Gateway 记录到 stderr 提示用户重新授权)
- [ ] 单测:RATE_LIMIT 第二次成功;AUTH_EXPIRED 不重试

## 集成

### T-98: typecheck + test
- [ ] `pnpm typecheck` 绿
- [ ] `pnpm test` 全绿,覆盖率维持
- [ ] `pnpm cli doctor` 绿

### T-99: 文档同步
- [ ] `docs/USAGE.md` §7.1 增加 "卡片未刷新 / update 失败" 排错
- [ ] `CHANGELOG.md`(若存在)增加 v0.9.0 条目
