#!/usr/bin/env bash
# scripts/smoke.sh —— 对运行中的 cicdkit-lume 做一次只读 HTTP 冒烟
# 用法: bash scripts/smoke.sh [http://127.0.0.1:8096]
set -uo pipefail

BASE="${1:-http://127.0.0.1:8096}"
fail=0
# 每次请求单独一个输出文件，失败时打印的才是这次的响应，而不是上一轮残留。
out="$(mktemp -t cicdkit-lume-smoke)"
trap 'rm -f "$out"' EXIT

check() {
  local path="$1" expect="${2:-200}" code
  : > "$out"
  # curl 连不上时也会往 -w 里写 000；不能再用 || echo 000 追加，否则拼成 "000000"。
  code="$(curl -s -o "$out" -w '%{http_code}' --max-time 8 "$BASE$path" 2>/dev/null)" || code=000
  if [ "$code" = "$expect" ]; then
    echo "✓ GET $path → $code"
  else
    echo "✗ GET $path → ${code}（期望 ${expect}）" >&2
    if [ -s "$out" ]; then head -c 400 "$out" >&2; echo >&2; fi
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
