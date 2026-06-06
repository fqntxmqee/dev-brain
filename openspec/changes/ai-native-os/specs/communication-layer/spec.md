---
demand-id: DM-20260606-003
change: ai-native-os
status: developing
---

# Communication Layer Spec (Delta — v0.11.0)

本文描述 AI Native OS 重构对通信层的 4 项增强:流式推送、签名鉴权、多模态、任务完成卡。
基础卡渲染、文本分片、卡片降级已在 v0.9.0 (feishu-upgrade-v0.9.0) 实现,本 spec 仅扩展,不动既有契约。

## CAP-COM-01 (NEW) 流式状态推送

**Given** 一次长任务处于 RUNNING 状态(辩论 / 子任务执行 / OpenSpec 生成)
**When** 引擎产生新的状态增量(LLM 思考 / 工具调用 / 进度更新)
**Then** StreamingPusher 把增量推送到对应飞书卡片,**节流 200ms**,合并相邻内容
**And** 卡片使用 `updateCard` 而非 `sendCard`,避免飞书端刷出多张
**And** 推送失败/超时(>2s)时回退到"下次合并推送",不阻塞主流程
**And** 任务结束时 `state: "done"` 触发一次性最终推送,所有缓冲内容 flush

**实现要点:**
- `src/gateway/streaming-pusher.ts` — 单例,持 `Map<planMessageId, Buffer>`
- 节流策略:同 planMessageId 200ms 内多次 push 合并,内容用 `\n` 拼接
- 卡片 schema: `{"type": "streaming", "elements": [{"tag": "markdown", "content": "<delta>"}]}`
- 飞书 API 限流感知:`lark-cli` 4xx/5xx 时 backoff 500ms 重试 1 次,仍失败写 `gateway.streaming.push_failed_total` +1
- 与 Phase A.5 trace_id 联动:每次 push 的 metadata 携带 trace_id,日志可关联

**Scenario: 辩论 Round 1 实时呈现**
- GIVEN 用户发"重构 trade 模块",Intent=refactor,ClarifyLoop 启动 R1
- WHEN Claude 思考 3s → 给出 `understanding: "..."`
- THEN 飞书卡片 header 出现 `[R1/3] 思考中...`,content 滚动更新为最终 understanding
- AND 心跳:每 200ms 检查 buffer,有新 delta 触发 update

**Scenario: 高频 push 合并**
- GIVEN 1s 内产生 8 个 delta(工具调用 + LLM token 增量)
- WHEN StreamingPusher 收到 8 个 push 调用
- THEN 实际只触发 1 次 `updateCard`(第 8 个触发,前 7 个合并进 buffer)
- AND 最终卡片内容包含全部 8 个 delta,顺序保持

**Scenario: 推送失败不阻塞主任务**
- GIVEN 飞书服务端 503
- WHEN updateCard 超时 > 2s
- THEN 错误吞掉,记 `gateway.streaming.push_failed_total`,主任务继续
- AND 下次 buffer 写入时自动重试 1 次

## CAP-COM-02 (NEW) 签名鉴权

**Given** 飞书回调任意 endpoint(消息 / 卡片按钮 / URL 验证)
**When** FeishuGateway 收到请求
**Then** SignatureVerifier 验证 HMAC-SHA256 签名(`X-Lark-Signature` header)
**And** 验签失败 → 立即返 401,不进入业务逻辑
**And** 验签通过 → 写 `gateway.signature.verified_total` +1
**And** secret 缺失(env `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` 空)→ daemon 启动 fail-fast

**实现要点:**
- `src/gateway/signature-verifier.ts` — 用 node:crypto,常时间比较防 timing attack
- secret 优先级:`DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` > `~/.dev-brain/secret` > 启动失败
- 提供 test 钩子 `verifyWithSecret(secret, body, signature)`,不绑 HTTP 层,便于单测
- 现状: v0.9.0 已支持 URL 验证(`verification_token`),但对 card.action 等回调未做强制验签,本 spec 强制化

**Scenario: 合法飞书回调通过**
- GIVEN secret = "abc123",飞书发送 `{"event": "..."}` + signature = HMAC(secret, body)
- WHEN FeishuGateway 处理请求
- THEN 验签通过,进入 dispatch
- AND 验签耗时 < 1ms

**Scenario: 伪造请求被拒**
- GIVEN secret = "abc123",攻击者发送 body 任意 + signature = "fake"
- WHEN FeishuGateway 处理
- THEN 返 401,`gateway.signature.rejected_total` +1,无业务副作用

**Scenario: secret 缺失启动失败**
- GIVEN env `DEV_BRAIN_FEISHU_VERIFICATION_TOKEN` 未设,`~/.dev-brain/secret` 不存在
- WHEN daemon 启动
- THEN 立即抛 `MissingVerificationSecretError`,exit 2,不监听端口

## CAP-COM-03 (NEW) 多模态输入

**Given** 用户发送含图片 / 文件附件 / PR 链接的消息
**When** FeishuGateway 收到 multimodal 消息
**Then** MultimodalParser 抽取:
  - 图片(message_content 里的 `image_key`)→ 调 MiniMax vision OCR,得文本描述 + 置信度
  - 文件(file 类型)→ 下载到 `~/.dev-brain/attachments/<msgId>/<fileName>`,返回本地路径
  - 文本中的 PR/issue 链接 → 调 GitHub API (or `gh pr view` 子进程) 抽 title + status + diff stat
**And** 解析结果并入 `IntentContext.attachments: { type, payload, confidence }[]`
**And** OCR 置信度 < 0.7 时,把原图保留在 Intent.attachments,但 Intent.ocr_low_confidence = true
**And** 整链路 trace_id 贯穿,可从 audit 还原"这张图被谁解析成什么"

**实现要点:**
- `src/gateway/multimodal-parser.ts` — 3 个子 parser,可独立调用
- MiniMax vision 走 cc-connect/native 通道,复用 v0.8.0 native backend
- GitHub 链接解析走 `gh` CLI 子进程(已装),无需新 dep
- 附件落盘:不直接放 workDir,放 `~/.dev-brain/attachments/`,避免污染 repo
- 与 inject-rules 联动:文件路径/OCR 文本也注入 system prompt,让 agent 能 reference

**Scenario: 用户贴截图报 bug**
- GIVEN 飞书消息: "[图片] 这里报错了" + image_key=img_v2_xxx
- WHEN MultimodalParser 处理
- THEN 调 MiniMax vision OCR,得 "TypeError: cannot read property 'foo' of undefined at trade.ts:42"
- AND 附件元数据并入 Intent.attachments
- AND 后续 debate 阶段可看到 OCR 文本作为 context

**Scenario: 用户贴 GitHub PR 链接**
- GIVEN 飞书消息: "看下这个 PR #123 https://github.com/foo/bar/pull/123"
- WHEN MultimodalParser 处理
- THEN 调 `gh pr view 123 --json title,state,additions,deletions,files`
- AND attachments 增加 `{type: "pr", ref: "foo/bar#123", title, state, diffStat}`
- AND Intent.type 升级为 "review" (heuristic: 含 pr 链接 + "看下" 关键字)

**Scenario: OCR 置信度低**
- GIVEN 图片模糊,vision 返回 confidence=0.4
- WHEN MultimodalParser 处理
- THEN OCR 文本仍写入,但附加 `ocr_low_confidence: true` 标记
- AND InjectRules 注入时附带警告"以下 OCR 文本可能不准确"

## CAP-COM-04 (NEW) 任务完成卡

**Given** 任务最终态为 SUCCESS 或 FAILED
**When** BrainEngine 发出 `task.complete` 事件
**Then** TaskDoneCard 构造结构化卡片,字段:
  - **summary**: 1-2 句结论(success/fail + 关键产出)
  - **changes**: 变更文件列表(最多 10 个,超 10 给"see git log"链接)
  - **tests**: 通过/失败计数 + 关键失败 message(最多 3 条)
  - **artifacts**: OpenSpec 路径 / checkpoint 路径 / 长输出文档链接
  - **trace_id**: 卡片 header 携带,可一键跳到 observability
**And** 卡片使用**原地 update** 而非 send,避免刷屏
**And** 失败时 summary 必须含**可读错误摘要**(从 adapter 输出的 stderr 抽关键行),不只 `❌ failed`

**实现要点:**
- `src/gateway/task-done-card.ts` — 纯函数 `buildTaskDoneCard(task, artifacts): Card`
- changes 列表从 `git diff --stat HEAD~1 HEAD` 拿(任务用 worktree 隔离)
- 文档链接:长输出 / 完整 diff / 完整 trace → 写 `~/.dev-brain/task-artifacts/<taskId>/index.html` 本地文件
- 与 `text-splitter` 协作:cards 超过 28KB 走 `card-degrader` 三段降级(已 v0.9.0)
- 失败时优先展示最后一次 self-correction 失败原因(Phase F CAP-MAR-04)

**Scenario: 简单 success**
- GIVEN task "trade 模块加日期筛选" SUCCESS,3 个子任务全过,12 个文件变更
- WHEN TaskDoneCard 构造
- THEN 卡片 6 个字段齐全,changes 列前 10 个文件 + "+2 more (see git log)"
- AND 飞书端原地 update 同一张计划卡,header 从 "[R3/3] 辩论中" 变成 "✅ 完成"

**Scenario: 失败带 self-correction 摘要**
- GIVEN task 失败,最后一次 self-correction 报错 "subtask st-3: TypeError: foo is not a function"
- WHEN TaskDoneCard 构造
- THEN summary = "❌ 任务失败: 3/5 子任务通过,最后错误 TypeError: foo is not a function at trade.ts:42"
- AND artifacts 含完整 stderr 链接(本地 HTML)
- AND 用户点 "查看失败原因" 按钮 → 飞书跳到本地 index.html

**Scenario: 长输出转文档**
- GIVEN 某子任务 stdout = 150KB(超过卡片容量)
- WHEN TaskDoneCard 构造
- THEN stdout 完整版写 `~/.dev-brain/task-artifacts/<taskId>/st-3.stdout.html`
- AND 卡片 artifacts 段含"查看完整输出"链接(本地 file:// 协议)
