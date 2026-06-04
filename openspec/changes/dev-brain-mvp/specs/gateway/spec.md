---
demand-id: DM-20260601-001
change: dev-brain-mvp
status: developing
---

# Feishu Gateway Spec (Delta)

## CAP-GW-01 消息订阅

**Given** lark-cli event 已配置 Brain 飞书应用  
**When** 用户发送文本消息  
**Then** Gateway 解析为 FeishuInboundMessage 并路由到 BrainEngine

## CAP-GW-03 意图解析

| 输入 | Intent |
|------|--------|
| `/help` | help |
| `/status` | status |
| `/approve` | approve |
| `/cancel` | cancel |
| 其他文本 | create_task |

## CAP-GW-02 回复

**Given** BrainEngine 返回计划或汇总  
**When** Reporter.sendText 被调用  
**Then** 飞书 chat 收到对应文本
