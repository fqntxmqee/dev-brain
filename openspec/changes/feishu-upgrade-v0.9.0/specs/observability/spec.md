---
demand-id: DM-20260608-001
change: feishu-upgrade-v0.9.0
status: developing
---

# Observability Spec (Delta — v0.9.0)

## CAP-OBS-04 (NEW) Gateway 错误分类计数

新增 Counter,`/metrics` 暴露:

| Counter 名 | Help |
|------------|------|
| `gateway.feishu.auth_expired` | 401 错误次数(AUTH_EXPIRED) |
| `gateway.feishu.rate_limited` | 429 错误次数(RATE_LIMIT) |
| `gateway.feishu.retry_succeeded` | 重试后成功次数 |
| `gateway.text.chunked` | 长文本分片次数 |
| `gateway.text.chunk_count_total` | 分片累计条数(便于算平均分片数) |
| `gateway.card.degraded` | 卡片降级次数 |
| `gateway.card.degrade_tier` | 降级档位 histogram:1/2/3 |

**用途:** 监控飞书 API 稳定性 + 长输出趋势,告警阈值:
- `rate_limited > 10/min` → 调频 / 加 jitter
- `auth_expired > 0` → 提示用户重新授权
- `degrade_tier{le="3"} > 0` → 长期高负载,需评估拆分子任务
