#!/bin/bash
# Start dev-brain daemon (v0.8.0: native agent adapters, cc-connect optional)
set -a
source /Users/fukai/workspace/dev-brain/.env
set +a
cd /Users/fukai/workspace/dev-brain
exec pnpm dev -- start
