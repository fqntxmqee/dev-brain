# dev-brain 可观测手册 (v0.10.0)

> 配套: `ops/grafana/dev-brain-dashboard.json`、`src/observability/metrics.ts`
>
> 适用版本: dev-brain v0.10.0 (Phase A.5 + B.2 + B.3)
>
> 目的: 10 分钟内看懂 dashboard 上的 17 个 panel,出问题知道往哪里查。

## 1. 整体架构一张图

```
飞书消息 ─→ feishu-gateway ─→ intent-classifier ─→ debate (claude×codex)
                                              │
                                              ↓ (consensus)
                                       openspec-generator
                                              │
                                              ↓ (OpenSpec delta)
                                       orchestrator (DAG)
                                              │
       ┌──────────────────────────────────────┼──────────────────┐
       ↓                                      ↓                  ↓
  runtime/checkpoint                   runtime/retry      adapter.send
  (per-subtask)                        (transient)        (claude/codex/cursor)
       │                                      │                  │
       └───────────────→ context-budget ←──────┴──────── resume-manager
                              │                            (daemon boot)
                              ↓
                    rules injector (4 sources + feedback)
                              │
                              ↓
                       track-rules (audit JSONL)
```

每条边都有 metric;每条实线都有 trace_id 贯穿 (Phase A.5)。

## 2. 10 个 v0.10.0 新增指标含义

### 2.1 流水线指标 (Phase A.5)

#### `debate_rounds_total` (counter)
- **含义**: 跑了多少轮 claude×codex 辩论(1~maxRounds)
- **看板位置**: Panel #13 "Spec Pipeline Throughput"
- **正常范围**: 5m 速率 0.1~2 (取决于用户在飞书提需求的频率)
- **异常**:
  - 突然飙到 10+ → 多次重试都没收敛,查 `debate_consensus_score` 看分差
  - 一直 0 → 没新需求进来,或 classifier 没把意图归到 `spec`

#### `debate_converge_total` (counter)
- **含义**: 在 maxRounds 内达成共识的次数
- **看板位置**: Panel #13
- **健康值**: `converge / rounds >= 0.7` (70% 收敛)
- **< 0.5 怎么办**:
  1. 调高 `SpecWorkflow.debate.consensusThreshold` (默认 0.85 → 0.8)
  2. 调高 `maxRounds` (默认 3 → 5)
  3. 看 consensus_score p95 是否 < 0.6 → 改写 system prompt 让两边立场更鲜明

#### `openspec_generated_total` (counter)
- **含义**: 共识后产出 OpenSpec 产物的次数
- **看板位置**: Panel #13
- **预期**: 与 `converge_total` 1:1 (每次共识 → 一份 delta spec)
- **< converge**: OpenSpec 写盘失败,查 `openspec/changes/` 目录权限

#### `debate_consensus_score` (histogram)
- **含义**: 共识分数分布(两 agent 立场相似度 0~1)
- **看板位置**: Panel #16
- **健康值**: p50 ≥ 0.8, p95 ≥ 0.7
- **p95 < 0.6**: 两边分歧太大,可能 system prompt 漏了某条规则 → 检 `instruction_rules_applied_total`

### 2.2 长程任务指标 (Phase A.5)

#### `runtime_checkpoint_writes` (counter)
- **含义**: checkpoint.write() 成功次数(per-subtask)
- **看板位置**: Panel #14
- **预期**: 与 `brain_subtasks_retried` 同步增长

#### `runtime_context_budget_triggers` (counter)
- **含义**: context-budget 自动 summarise 触发次数
- **看板位置**: Panel #15 (stat)
- **健康值**: 5m 速率 < 1 (偶尔触发 = 任务正常,频繁 = 模型上下文超限)
- **持续 > 5/min**:
  1. 任务 prompt 太大 → 拆成子任务
  2. 单 subtask 太多 round → 调高 checkpoint 频率
  3. 升级到 long-context 模型

#### `runtime_retry_total` (counter)
- **含义**: retry-policy 重试次数(成功+耗尽)
- **看板位置**: Panel #14
- **健康值**: 5m 速率 < 总 subtask 的 10%
- **持续 > 30%**:
  1. 看 `runtime.resume_total` 是不是也涨 → 任务被打断
  2. 看 `adapter.failed` 是不是也涨 → 下游 agent 不稳
  3. 调高 `RetryPolicy.maxAttempts` 没用,查根本原因

#### `runtime_resume_total` (counter)
- **含义**: daemon 启动时扫描到的 in_progress resume 计划数
- **看板位置**: Panel #14
- **健康值**: 单次启动 < 5(任务都被正常完成,无遗留)
- **持续 > 10**:
  1. 看 `runtime.retry_total` → 任务在跑 retry 死循环
  2. 看 `process.eventloop_lag_seconds` → 主线程卡
  3. 是不是用户没批准 plan → `brain.pending_plans` 也涨

### 2.3 指令遵循指标 (Phase B.2 + B.3)

#### `instruction_rules_applied_total` (counter)
- **含义**: 注入到 agent 的规则条数(每次 agent 调用 × 规则数)
- **看板位置**: Panel #17
- **预期**: 与 `adapter.sent` 同数量级(每次 agent 都注入了规则)
- **< adapter.sent × 5**: 规则文件路径配错,或 token 预算太低被截断 → 看 `InjectorRules.dropped`

#### `instruction_rules_violated_total` (counter)
- **含义**: 用户/LLM 检测到规则违反的次数
- **看板位置**: Panel #17
- **健康值**: 5m 速率 < `applied_total` 的 1%
- **持续 > 5%**:
  1. 规则太严,model 反复违反 → 把"必须/禁止"改成"建议"
  2. 规则文本不清楚 → 改写、加示例
  3. 注入被截断 → 提高 `InjectRules.tokenBudget`

#### `instruction_feedback_recorded_total` (counter)
- **含义**: 用户在聊天/审查中纠正 agent 的次数
- **看板位置**: Panel #17
- **健康值**: 用户侧决定;稳步增长是好事(用户参与度)

#### `instruction_feedback_injected_total` (counter)
- **含义**: 反馈条目被渲染进 system prompt 的次数
- **看板位置**: Panel #17
- **预期**: 与 `feedback_recorded_total` 滞后 1~2 个任务周期
- **远 < recorded**: `InjectRules.extraSources` 没接上,或 `FeedbackMemory.renderAsRuleSections` 报错

## 3. 故障排查 Playbook

### 3.1 "任务跑了很久没结果"

```
1. 看 Panel #12 "Brain Pending / Active" → 是 pending 还是 active?
   - pending: 用户没批准 plan → 提醒用户去飞书点"批准"
   - active: 看下一步

2. 看 Panel #14 "Runtime" → checkpoint 在涨吗?
   - 不涨: subtask 卡住,看 trace_id 找日志
   - 涨: 正常,只是慢

3. 看 Panel #15 "Context Budget Triggers" → 频繁触发?
   - 是: 见 2.2 context_budget
   - 否: 看 adapter 侧

4. 看 Panel #5 "cc-connect Send p95" / #6 "Adapter" → 下游 agent 健康吗?
   - p95 > 60s: agent 慢,可能 OOM,看 `process.heap_bytes`
   - failed > 0: 看 `runtime.retry_total` 是否在涨
```

### 3.2 "OpenSpec 没生成"

```
1. 看 `debate_rounds_total` → 跑了辩论吗?
   - 0: 走错分支,看 `intent.classify.duration_seconds` 或 classifier 日志
   - 有: 走 #2

2. 看 `debate_converge_total` → 收敛了吗?
   - == rounds 但没 generated: OpenSpecGenerator 抛错,查 openspec/changes/ 写盘
   - 没收敛: 调高 maxRounds 或 consensusThreshold

3. 看 Panel #11 "HTTP Request Rate" → /healthz 还在响应?
   - 没响应: 进程崩了,看 logs/ 和 postmortem.json
```

### 3.3 "agent 总是违反某条规则"

```
1. 看 `instruction_rules_violated_total` → 是哪条规则?
   - 查 `~/.dev-brain/rules-audit/rules-YYYY-MM-DD.jsonl` 看 rule_rel

2. 看 `instruction_rules_applied_total` → 这条规则真注入了?
   - 没注入: 路径配错 / 被 token 预算截断 / 文件 mtime 缓存
   - 注入了: 走 #3

3. 改写规则文本(更具体 / 加反例)
   加进 `~/.claude/rules/<scope>/<name>.md`,等下一次 mtime 变化自动注入
```

### 3.4 "用户反馈没生效"

```
1. 看 `instruction_feedback_recorded_total` → 反馈被记录了吗?
   - 没: 反馈入口没接上,查 FeedbackMemory.recordCorrection 调用点
   - 有: 走 #2

2. 看 `instruction_feedback_injected_total` → 渲染过吗?
   - 0: `InjectRules.extraSources` 没接 / FeedbackMemory.renderAsRuleSections 报错
   - 有但 agent 仍犯同样错: 反馈内容太模糊,改写 corrected 字段
```

### 3.5 "Daemon 启动后 resume 太多"

```
1. 看 `runtime_resume_total` 单次扫描数
   - < 5: 健康(零星遗留)
   - 5~20: 看 #2
   - > 20: 任务系统有问题,看 #3

2. 看 `runtime.retry_total` 是否同步涨
   - 涨: retry 死循环,看 RetryPolicy.maxAttempts
   - 没涨: 看 `process.eventloop_lag_seconds` → 主线程卡

3. 是不是用户 cancel 失败 / plan 长时间没批
   - 看 `brain.pending_plans` 是不是持续 > 0
   - 看 file lock: file_lock_conflicts / file_lock.held
```

## 4. 常用 PromQL 模板

```promql
# 任务 5m 吞吐
sum(rate(brain_tasks_completed[5m]))

# 收敛率
sum(rate(debate_converge_total[15m])) / sum(rate(debate_rounds_total[15m]))

# Resume 率(每次启动)
sum(rate(runtime_resume_total[1h])) by (trace_id)  # 注意 resume_total 本身累计,看 per-trace

# 规则违反率
sum(rate(instruction_rules_violated_total[1h])) / sum(rate(instruction_rules_applied_total[1h]))

# 反馈注入率
sum(rate(instruction_feedback_injected_total[1h])) / sum(rate(instruction_feedback_recorded_total[1h]))
```

## 5. 本地查看方式

```bash
# 启动 dev-brain 后,scrape 一次
curl -s http://127.0.0.1:<metrics-port>/metrics | grep -E "^(debate|runtime|openspec|instruction)_"

# 实时跟踪某个 trace
TRACE=trace-xxx
grep "$TRACE" .omc/logs/*.jsonl
tail -f <audit-dir>/rules-$(date -u +%Y-%m-%d).jsonl | jq "select(.trace_id==\"$TRACE\")"
```

## 6. 相关文件

| 文件 | 作用 |
|---|---|
| `src/observability/metrics.ts` | 53 个 metric 声明 + 注册表 |
| `src/observability/trace.ts` | AsyncLocalStorage trace_id 注入 |
| `src/agent/inject-rules.ts` | 规则源加载 + token 预算 |
| `src/agent/track-rules.ts` | 规则事件审计 |
| `src/agent/feedback-memory.ts` | 用户反馈存储 + 注入 |
| `ops/grafana/dev-brain-dashboard.json` | Grafana 17 panel dashboard |
| `tests/unit/grafana-dashboard.test.ts` | panel 引用 metric 与注册表一致性校验 |
