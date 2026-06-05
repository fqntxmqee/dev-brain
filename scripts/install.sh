#!/bin/bash
# Dev Brain v0.8.0 — 一键安装/启动脚本
#
# 做 4 件事:
#   1. 环境检查 (node/pnpm/lark-cli/claude/codex-minimax/MINIMAX_API_KEY)
#   2. 引导 .env (首次: 复制 .env.example + 提示输入飞书 app/secret/open_id)
#   3. (可选) 注册 lark-cli profile (第一次连接到 dev-brain 飞书 app)
#   4. (可选) 启动 daemon (--start) / doctor 自检 (--check)
#
# 用法:
#   ./scripts/install.sh           引导 .env + lark-cli profile
#   ./scripts/install.sh --check   跑 doctor 自检
#   ./scripts/install.sh --start   启动 daemon (前台)
#   ./scripts/install.sh --all     引导 + doctor + 启动
#
# Reentrant: 再次运行只做缺的那步。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
LARK_PROFILE="dev-brain"

MODE="install"
[[ "${1:-}" == "--check" ]] && MODE="check"
[[ "${1:-}" == "--start" ]] && MODE="start"
[[ "${1:-}" == "--all" ]]   && MODE="all"

# 颜色
G='\033[0;32m'; Y='\033[0;33m'; R='\033[0;31m'; N='\033[0m'

step() { printf "${G}▸${N} %s\n" "$*"; }
warn() { printf "${Y}⚠${N}  %s\n" "$*" >&2; }
fail() { printf "${R}✗${N}  %s\n" "$*" >&2; exit 1; }
ok()   { printf "${G}✓${N}  %s\n" "$*"; }

# ─── 1. 环境检查 ───────────────────────────────────────────────
check_env() {
  step "1/4 环境检查"
  local missing=0

  for bin in node pnpm; do
    if command -v "$bin" >/dev/null 2>&1; then
      ok "$bin: $(command -v $bin)"
    else
      fail "$bin: 未安装。请安装 Node.js ≥ 20 + pnpm ≥ 9。"
    fi
  done

  # Node 版本
  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [ "$node_major" -lt 20 ]; then
    fail "Node.js ≥ 20 required, 当前 v$(node -v)"
  fi

  for bin in lark-cli claude codex-minimax; do
    if command -v "$bin" >/dev/null 2>&1; then
      ok "$bin: $(command -v $bin)"
    else
      warn "$bin: 未安装 — live 模式需要; stub 模式可跳过"
      missing=1
    fi
  done

  if [ -z "${MINIMAX_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    warn "MINIMAX_API_KEY / ANTHROPIC_API_KEY: 均未设置 — claude / codex 调用会失败"
    missing=1
  else
    ok "API key: 已设置 (MINIMAX_API_KEY 或 ANTHROPIC_API_KEY)"
  fi

  if [ "$missing" -ne 0 ] && [ "$MODE" != "check" ]; then
    warn "有未安装的依赖。stub 模式可继续,live 模式需先补齐。"
  fi
}

# ─── 2. 安装依赖 ───────────────────────────────────────────────
install_deps() {
  step "2/4 安装 Node 依赖"
  if [ -d "$ROOT_DIR/node_modules" ]; then
    ok "node_modules: 已存在 (跳过 pnpm install)"
  else
    pnpm install --silent
    ok "pnpm install 完成"
  fi
}

# ─── 3. 引导 .env ─────────────────────────────────────────────
bootstrap_env() {
  step "3/4 配置 .env"

  if [ ! -f "$ENV_FILE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    ok "已复制 .env.example → .env"
  else
    ok ".env: 已存在 (跳过复制)"
  fi

  # 读取现有值
  local app_id app_secret allow_from
  app_id="$(grep '^DEV_BRAIN_FEISHU_APP_ID=' "$ENV_FILE" | cut -d= -f2- || true)"
  app_secret="$(grep '^DEV_BRAIN_FEISHU_APP_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
  allow_from="$(grep '^DEV_BRAIN_ALLOW_FROM=' "$ENV_FILE" | cut -d= -f2- || true)"

  # 检测占位
  is_placeholder() { echo "$1" | grep -qE '^(cli_xxx|xxx|your_|replace_me|<|TODO)'; }

  local need_input=0
  if is_placeholder "$app_id";     then need_input=1; warn "DEV_BRAIN_FEISHU_APP_ID 是占位值"; fi
  if is_placeholder "$app_secret"; then need_input=1; warn "DEV_BRAIN_FEISHU_APP_SECRET 是占位值"; fi

  if [ "$need_input" -eq 1 ]; then
    echo ""
    echo "在 https://open.feishu.cn/app 新建企业自建应用 (Brain 专用 Bot),"
    echo "把 App ID / App Secret 粘到下面。"
    echo ""

    if [ -t 0 ]; then
      read -r -p "DEV_BRAIN_FEISHU_APP_ID     [${app_id}]: " input_app_id
      read -r -p "DEV_BRAIN_FEISHU_APP_SECRET [hidden]: " input_app_secret
      read -r -p "DEV_BRAIN_ALLOW_FROM (open_id; * = 任何人) [${allow_from:-*}]: " input_allow

      [ -n "$input_app_id" ]     && sed -i.bak "s|^DEV_BRAIN_FEISHU_APP_ID=.*|DEV_BRAIN_FEISHU_APP_ID=$input_app_id|" "$ENV_FILE"
      [ -n "$input_app_secret" ] && sed -i.bak "s|^DEV_BRAIN_FEISHU_APP_SECRET=.*|DEV_BRAIN_FEISHU_APP_SECRET=$input_app_secret|" "$ENV_FILE"
      [ -n "$input_allow" ]      && sed -i.bak "s|^DEV_BRAIN_ALLOW_FROM=.*|DEV_BRAIN_ALLOW_FROM=$input_allow|" "$ENV_FILE"
      rm -f "$ENV_FILE.bak"
      ok ".env 已更新"
    else
      fail ".env 含占位值且 stdin 非 TTY — 手动编辑 $ENV_FILE 后重跑"
    fi
  else
    ok ".env 关键字段已配置: APP_ID=$app_id, ALLOW_FROM=$allow_from"
  fi

  # 同步 .env 到当前 shell (供后续 lark-cli 步骤用)
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
}

# ─── 4. lark-cli profile 注册 ─────────────────────────────────
register_lark_profile() {
  step "4/4 注册 lark-cli profile [$LARK_PROFILE]"

  # 检查是否已注册
  if lark-cli config list --format json 2>/dev/null | grep -q "\"$LARK_PROFILE\""; then
    ok "lark-cli profile [$LARK_PROFILE]: 已存在"
    return
  fi

  if [ -z "${DEV_BRAIN_FEISHU_APP_ID:-}" ] || [ -z "${DEV_BRAIN_FEISHU_APP_SECRET:-}" ]; then
    warn "缺少飞书凭证,跳过 lark-cli profile 注册"
    return
  fi

  if [ -t 0 ]; then
    printf "正在注册 lark-cli profile (app_id=%s)...\n" "$DEV_BRAIN_FEISHU_APP_ID"
    printf "%s" "$DEV_BRAIN_FEISHU_APP_SECRET" | lark-cli config init \
      --name "$LARK_PROFILE" \
      --app-id "$DEV_BRAIN_FEISHU_APP_ID" \
      --app-secret-stdin 2>&1 | tail -5
    ok "lark-cli profile [$LARK_PROFILE] 注册完成"
  else
    warn "stdin 非 TTY,跳过 lark-cli profile 注册 (手动: lark-cli config init --name dev-brain --app-id $DEV_BRAIN_FEISHU_APP_ID --app-secret-stdin)"
  fi
}

# ─── doctor 自检 ──────────────────────────────────────────────
run_doctor() {
  step "🩺 dev-brain doctor"
  pnpm cli -- doctor
}

# ─── 启动 daemon ──────────────────────────────────────────────
start_daemon() {
  step "🧠 启动 daemon (前台, Ctrl+C 退出)"
  exec pnpm cli -- start
}

# ─── main ────────────────────────────────────────────────────
case "$MODE" in
  install)
    check_env
    install_deps
    bootstrap_env
    register_lark_profile
    echo ""
    ok "安装完成。下一步:"
    echo "  ./scripts/install.sh --check   # 环境自检"
    echo "  ./scripts/install.sh --start   # 启动 daemon"
    ;;
  check)
    check_env
    run_doctor
    ;;
  start)
    bootstrap_env  # 至少确认 .env 存在
    start_daemon
    ;;
  all)
    check_env
    install_deps
    bootstrap_env
    register_lark_profile
    run_doctor
    echo ""
    ok "预检通过,启动 daemon..."
    start_daemon
    ;;
esac
