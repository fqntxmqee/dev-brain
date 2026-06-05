# Dev Brain v0.7.0 — Oncall Runbook

Quick reference + per-alert procedures for production incidents.
The 7 alert rules live in `ops/alerts/dev-brain-rules.yml`; each section
below corresponds to one alert. Sections in §2-§8 use the same
**Symptom → Diagnosis → Mitigation → Escalation** structure.

## §1 Quick Reference

### Endpoints (v0.7.0+)

| Endpoint | Purpose | Returns |
|---|---|---|
| `GET /healthz` | liveness | `200 {"status":"ok"}` always |
| `GET /readyz`  | readiness | `200 {"status":"ready"}` if not shutting down, else `503` |
| `GET /metrics` | Prometheus text | see `curl /metrics \| head -50` |

### CLI subcommands

```bash
dev-brain doctor                    # env self-check (feishu / cc-connect / cursor)
dev-brain status                    # brain pending/active counters
dev-brain show <taskId>             # postmortem of a completed task
dev-brain list [--limit N]          # recent N completed tasks
dev-brain probe -p <project> <msg>  # send probe message to one cc-connect project
dev-brain start --dry-run           # print resolved config without starting
```

### Filter logs by correlation ID

```bash
# JSON logs go to stderr. Filter by request_id / task_id / chat_id:
journalctl -u dev-brain -o cat | jq 'select(.request_id == "abc-123")'
journalctl -u dev-brain -o cat | jq 'select(.task_id == "def-456")'
```

### Metric series names

All metric names below are emitted by `getMetricsText()` at `http://host:9090/metrics`.

- Counters (rate-able): `brain_tasks_completed_total`, `brain_tasks_failed_total`,
  `file_lock_conflicts_total`, `adapter_sent`, `adapter_failed`, `adapter_cancelled`,
  `gateway_messages_received`, `gateway_messages_rejected_oversize`, `gateway_card_action`,
  `bridge_http_fallback`, `http_metrics_requests_total`, `http_healthz_requests_total`,
  `http_readyz_requests_total`, `http_404_requests`.
- Gauges: `brain_pending_plans`, `brain_active_tasks`, `brain_active_subtasks`,
  `file_lock_held`, `cc_socket_reachable`, `process_heap_bytes`, `process_rss_bytes`,
  `process_eventloop_lag_seconds`, `process_uptime_seconds`.
- Histograms: `brain_task_duration_seconds`, `brain_subtask_duration_seconds`,
  `cc_send_duration_seconds`, `gateway_message_duration_seconds`.

---

## §2 BrainHighFailureRate (page)

**Expression:** `rate(brain_tasks_failed_total[5m]) / rate(brain_tasks_completed_total[5m]) > 0.25`
**For:** 10m

### Symptom
Pager: "Brain task failure rate above 25% for 10m". Oncall sees sustained
failure ratio in the Brain Tasks panel of the Grafana dashboard.

### Diagnosis
1. `curl http://localhost:9090/metrics | grep brain_tasks` — confirm
   `brain_tasks_failed_total` is climbing.
2. `dev-brain list` — look at recent failures and their summaries.
3. For each failed task, `dev-brain show <taskId> --subtask <id>` to see
   the full error from the adapter.
4. `journalctl -u dev-brain -o cat | jq 'select(.level == "error")' | tail -50`
   — find common error patterns (e.g. all pointing to a single runtime).

### Mitigation
- If failures concentrate on one runtime (claude-code / codex / cursor):
  check `cc_socket_reachable` (gauge == 0 ⇒ UDS down ⇒ page on §4 too).
- If all runtimes fail: confirm cc-connect daemon is running
  (`pgrep -af cc-connect`); restart if absent.
- If the failure pattern matches a known adapter bug, roll back the
  adapter by setting `DEV_BRAIN_ADAPTER_MODE=stub` and rolling the
  previous dev-brain release.
- If only 1-2 tasks are failing in isolation, the issue is likely
  content-specific — review the prompt and consider rejecting the task
  back to the user.

### Escalation
If the failure rate is rising for >30m with no clear adapter cause,
page the brain-engine owner; check `git log` for recent changes to
`src/brain/`.

---

## §3 BrainStuckTask (warn)

**Expression:** `histogram_quantile(0.95, brain_task_duration_seconds) > 1800`
**For:** 15m

### Symptom
Dashboard: "Brain Task Duration p95" line above 30 minutes for 15m.
Tasks are completing very slowly (or hanging at p95).

### Diagnosis
1. `dev-brain status` — see how many tasks are in active state.
2. `curl http://localhost:9090/metrics | grep brain_active` — check
   `brain_active_tasks` and `brain_active_subtasks`. If both are non-zero
   for the alert window, tasks are accumulating.
3. For each active task, look up the most recent log line via
   `task_id=<id>` to see which subtask is hanging.
4. Check `cc_send_duration_seconds` p95 — if it's also high, the adapter
   is the bottleneck; if not, the brain-engine itself is stuck (rare).

### Mitigation
- If a specific task is stuck on a cc-connect call, kill the task with
  `dev-brain plan` reprompt + `/cancel` from the user.
- If `cc_send_duration_seconds` is high, see §4 (cc-connect down).
- If many tasks are queued, raise the concurrency cap (currently 1 task
  per chat) or warn the user about backpressure.

### Escalation
If p95 stays above 30 min for >1h, page the orchestrator owner and
consider restarting the process with a fresh `node dist/cli/cli.js start`.

---

## §4 CcConnectSocketDown (page)

**Expression:** `cc_socket_reachable == 0`
**For:** 2m

### Symptom
Pager: "cc-connect socket unreachable for 2m". No adapter (claude-code,
codex, cursor) can dispatch work.

### Diagnosis
1. `ls -la ~/.cc-connect/run/api.sock` — verify the UDS file exists.
2. `pgrep -af cc-connect` — verify the cc-connect daemon is running.
3. `dev-brain doctor` — full env self-check.
4. `journalctl -u cc-connect -n 100 --no-pager` — daemon logs.
5. `curl --unix-socket ~/.cc-connect/run/api.sock http://localhost/sessions`
   — direct UDS probe.

### Mitigation
- If the daemon is not running: `systemctl start cc-connect` (or
  equivalent on this host) and verify it comes back healthy.
- If the UDS file is missing: the daemon crashed mid-start; check
  `~/.cc-connect/logs/` for startup errors.
- If the socket is on a different path: update
  `DEV_BRAIN_CC_CONNECT_SOCKET` in the env, restart dev-brain.
- If cc-connect is healthy but dev-brain still reports unreachable,
  restart dev-brain with `kill -TERM <pid>` then restart.

### Escalation
If the daemon won't stay up for >10m, page the cc-connect owner and
check `~/.cc-connect/config.toml` for syntax errors.

---

## §5 FileLockContention (warn)

**Expression:** `rate(file_lock_conflicts_total[5m]) > 0.5`
**For:** 10m

### Symptom
Dashboard: "File Lock Held & Conflicts" panel — conflict rate > 0.5/s.
Multiple agents are fighting over the same files.

### Diagnosis
1. `curl http://localhost:9090/metrics | grep file_lock` — current
   `file_lock_held` count and which paths.
2. For each running task, look at the log for `lock conflict` warnings
   (these are emitted with `file: <redacted_path>`).
3. `dev-brain list` — see recent task summaries; are they all touching
   the same module?
4. `journalctl -u dev-brain -o cat | grep "LockConflictError" | tail -20`

### Mitigation
- If a single file is hot: review the plan for that task; maybe split
  into smaller subtasks with non-overlapping file scopes.
- If conflicts are random: lower concurrency (already 1, so this is rare)
  or have the user cancel the contended task.
- If the contention is between unrelated projects, the file-scope rules
  may be too coarse — review `src/governance/file-lock.ts`.

### Escalation
Sustained > 0.5/s for >1h with no obvious hot file: page the
governance owner; consider widening the file-pattern matching.

---

## §6 ProcessOomRisk (warn)

**Expression:** `process_heap_bytes > 1.5e9`
**For:** 5m

### Symptom
Dashboard: "Process Memory (heap / rss)" panel — heap > 1.5 GB.
Risk of V8 OOM crash within minutes.

### Diagnosis
1. `curl http://localhost:9090/metrics | grep process_` — heap + rss.
2. `ps -o pid,rss,vsz,cmd -p <pid>` — confirm RSS too.
3. `node --inspect <pid>` or `kill -USR2 <pid>` if heap snapshots are
   configured; otherwise, take a heap snapshot via the inspector.
4. Check `journalctl` for `JavaScript heap out of memory` lines from
   recent past.

### Mitigation
- **Soft restart:** `kill -TERM <pid>` (SIGTERM) — GracefulShutdown
  gives 10s for cleanup, then exits cleanly. The process supervisor
  should auto-respawn.
- **Hard restart (if soft hangs):** `kill -KILL <pid>` and let the
  supervisor restart.
- After restart, monitor the new heap growth rate. If it climbs back
  to 1.5GB in <24h, page the brain-engine owner for a memory leak
  investigation.

### Escalation
If the heap climbs back to > 1.5GB within 24h of restart twice in a
row, page the brain-engine owner and consider downgrading to the
previous v0.6.0 release as a temporary mitigation.

---

## §7 EventLoopLag (warn)

**Expression:** `process_eventloop_lag_seconds > 0.5`
**For:** 5m

### Symptom
Dashboard: "Event Loop Lag (p99)" panel — p99 > 500ms. The Node.js
event loop is consistently lagging, meaning CPU starvation or a
blocking sync call in a hot path.

### Diagnosis
1. `top -p <pid>` — check CPU usage. If at 100% of one core, look for
   a busy loop in recent log output.
2. `strace -p <pid> -c -e trace=read,write,recvfrom,sendto` (5s) — see
   which syscalls are hot.
3. `clinic doctor --on-port <inspector-port>` if Node Clinic is
   available — flame graph of the event loop.
4. Check `brain_subtask_duration_seconds` p95 — if also high, the lag
   is from a single subtask; if low, the lag is in the main loop
   (likely file-lock or metrics-emission path).

### Mitigation
- If a specific task is hogging CPU: identify it via
  `dev-brain status` and `/cancel` from the user.
- If the lag is in metrics emission: check that
  `getMetricsText()` is not being called in a hot path (it should only
  fire on /metrics scrapes, not in the message loop).
- Short-term: restart the process; long-term: identify and fix the
  blocking call.

### Escalation
If event loop lag is sustained > 1s for >30m, page the
orchestration owner; this is almost always a bug, not a load issue.

---

## §8 AdapterAllFailed (page)

**Expression:** `rate(adapter_failed[5m]) > 0 AND rate(adapter_sent[5m]) == 0`
**For:** 5m

### Symptom
Pager: "Adapters failing with no successes for 5m". No adapter has
successfully completed a send in 5 minutes, but failures are occurring.

### Diagnosis
1. `curl http://localhost:9090/metrics | grep adapter_` — per-runtime
   failure counts.
2. `dev-brain doctor` — full env check, especially cursor_api_key.
3. `journalctl -u dev-brain -o cat | jq 'select(.msg | test("adapter|send"))' | tail -50`
4. For each runtime (claude-code / codex / cursor), verify the
   corresponding cc-connect project is configured:
   `cat ~/.cc-connect/config.toml | grep -A 5 <project>`

### Mitigation
- If all three runtimes fail: cc-connect itself is likely broken — see
  §4 CcConnectSocketDown.
- If only cursor fails: check `CURSOR_API_KEY` is valid and not
  rate-limited (HTTP 429). If rate-limited, fail over to claude-code
  or codex.
- If only one runtime fails (rare): it's a runtime-specific issue;
  page that runtime's owner and temporarily disable it in
  `~/.cc-connect/config.toml` by removing the project entry.

### Escalation
If > 15m of complete adapter failure with no clear cause, page the
infrastructure owner and check `~/.cc-connect/logs/` for daemon-level
errors.

---

## §9 Common commands

```bash
# Tail JSON logs from the running process
journalctl -u dev-brain -f -o cat

# Filter by a specific request_id (Feishu message ID)
journalctl -u dev-brain -o cat | jq -c 'select(.request_id == "m_abc123")'

# Filter by task_id
journalctl -u dev-brain -o cat | jq -c 'select(.task_id == "def-456")'

# Live metrics scrape (use with `watch` or `while` loop)
watch -n 5 'curl -s http://localhost:9090/metrics | grep -E "brain_(active|pending|tasks)"'

# Send a test Feishu-style message without a real gateway
DEV_BRAIN_ADAPTER_MODE=stub dev-brain plan "test task"
```
