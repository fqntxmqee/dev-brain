#!/usr/bin/env bash
# observability-smoke.sh — production observability integration check (v0.7.0)
#
# Verifies:
#   1. typecheck + test + coverage thresholds
#   2. metrics server boots and /metrics + /healthz + /readyz all respond
#   3. /metrics output includes all expected metric families
#   4. dry-run shows the new metrics config line
#
# Usage:
#   pnpm smoke              # full check
#   pnpm smoke --no-tests   # skip typecheck/test/coverage (faster)

set -euo pipefail

cd "$(dirname "$0")/.."

PORT=19091
BASE="http://127.0.0.1:${PORT}"
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --no-tests) SKIP_TESTS=1 ;;
  esac
done

if [ "$SKIP_TESTS" = "0" ]; then
  echo "▶ typecheck"
  pnpm typecheck
  echo "▶ test"
  pnpm test
  echo "▶ coverage (threshold check)"
  pnpm test:coverage
fi

echo "▶ boot metrics server on ${PORT}"
node -e "
  import('./dist/observability/metrics-server.js').then(async ({ MetricsServer }) => {
    const { getMetrics } = await import('./dist/observability/metrics.js');
    const ms = new MetricsServer({ port: ${PORT}, host: '127.0.0.1', registry: getMetrics() });
    const h = await ms.start();
    process.stdout.write('PORT=' + h.port + '\n');
    setInterval(() => {}, 1 << 30);
  });
" > /tmp/obs-smoke.log 2>&1 &
SERVER_PID=$!

# wait for server to be reachable
for i in {1..30}; do
  if curl -fsS "${BASE}/healthz" >/dev/null 2>&1; then break; fi
  sleep 0.2
done

cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "▶ /healthz"
HEALTH=$(curl -sS -o /tmp/h.txt -w "%{http_code}" "${BASE}/healthz")
[ "$HEALTH" = "200" ] || { echo "FAIL: /healthz HTTP $HEALTH"; cat /tmp/h.txt; exit 1; }
grep -q '"status":"ok"' /tmp/h.txt || { echo "FAIL: /healthz body"; cat /tmp/h.txt; exit 1; }

echo "▶ /readyz"
READY=$(curl -sS -o /tmp/r.txt -w "%{http_code}" "${BASE}/readyz")
[ "$READY" = "200" ] || { echo "FAIL: /readyz HTTP $READY"; cat /tmp/r.txt; exit 1; }

echo "▶ /metrics (expect ≥ 50 lines, all 7 alert metric families present)"
curl -sS "${BASE}/metrics" > /tmp/m.txt
LINES=$(wc -l < /tmp/m.txt)
[ "$LINES" -ge 50 ] || { echo "FAIL: only $LINES lines in /metrics"; exit 1; }

EXPECTED_METRICS=(
  "brain.tasks.completed"
  "brain.tasks.failed"
  "brain.pending_plans"
  "brain.active_tasks"
  "file.lock.held"
  "cc.socket.reachable"
  "process.heap_bytes"
  "process.rss_bytes"
  "process.eventloop_lag_seconds"
  "brain.task.duration_seconds"
  "brain.subtask.duration_seconds"
  "cc.send.duration_seconds"
)
for m in "${EXPECTED_METRICS[@]}"; do
  if ! grep -q "^# HELP $m " /tmp/m.txt; then
    echo "FAIL: metric $m missing from /metrics"
    exit 1
  fi
done

echo "▶ dry-run output"
DRY=$(pnpm dev start --dry-run 2>/dev/null)
echo "$DRY" | grep -q "metrics:" || { echo "FAIL: dry-run missing metrics line"; echo "$DRY"; exit 1; }

echo "▶ alerts YAML has 7 alert rules"
ALERTS=$(grep -cE "^[[:space:]]*- alert:" ops/alerts/dev-brain-rules.yml)
[ "$ALERTS" = "7" ] || { echo "FAIL: expected 7 alert rules, got $ALERTS"; exit 1; }

echo "▶ dashboard JSON valid"
node -e "JSON.parse(require('fs').readFileSync('ops/grafana/dev-brain-dashboard.json'))"

echo "✅ observability smoke OK"
