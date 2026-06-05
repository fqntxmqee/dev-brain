#!/usr/bin/env bash
# Pre-commit hook: 阻断质量不达标的提交
# 安装：git config core.hooksPath scripts/hooks

set -euo pipefail

STAGED_TS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx)$' || true)
STAGED_JS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(js|jsx)$' || true)
STAGED_ALL="$STAGED_TS $STAGED_JS"

if [ -z "$(echo "$STAGED_ALL" | tr -d ' ')" ]; then
  exit 0
fi

echo "🔍 pre-commit: typecheck..."
pnpm typecheck

echo "🔍 pre-commit: lint..."
pnpm lint

echo "🔍 pre-commit: test..."
pnpm test

echo "✅ pre-commit: all checks passed"
