#!/usr/bin/env bash
# scripts/smoke.sh —— 对运行中的 cicdkit-lume 做一次只读 HTTP 冒烟
# 用法: bash scripts/smoke.sh [http://127.0.0.1:8096]
set -uo pipefail

BASE="${1:-http://127.0.0.1:8096}"
fail=0

check() {
  local path="$1" expect="${2:-200}" code
  code="$(curl -s -o /tmp/cicdkit-lume-smoke.out -w '%{http_code}' --max-time 8 "$BASE$path" || echo 000)"
  if [ "$code" = "$expect" ]; then
    echo "✓ GET $path → $code"
  else
    echo "✗ GET $path → $code（期望 $expect）" >&2
    head -c 400 /tmp/cicdkit-lume-smoke.out >&2 || true
    echo >&2
    fail=1
  fi
}

check /
check /app.css
check /app.js
check /api/health
check /api/meta
check /api/overview
check /api/projects
check /api/runs
check /api/deployments

exit "$fail"
