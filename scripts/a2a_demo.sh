#!/usr/bin/env bash
# A2A 只读面演示：读 Agent Card、发 message/send、再按 task id 查 tasks/get。
#
#   make a2a-demo
#   ./scripts/a2a_demo.sh card
#   ./scripts/a2a_demo.sh caps
#   ./scripts/a2a_demo.sh send cicd.recent_runs '{"limit":3}'
#   ./scripts/a2a_demo.sh get <task_id>
#   BASE_URL=http://127.0.0.1:8096 ./scripts/a2a_demo.sh demo
#
# 认证：默认从仓库根 .env 读 CICDKIT_BASIC_USER / CICDKIT_BASIC_PASS；
# 没配就按无认证调用（适合 `make dev` 直连）。口令只在 curl 参数里出现，
# 不打印、不写临时文件。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:18107}"
BASE_URL="${BASE_URL%/}"

if [ -f "$ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
fi

AUTH=()
if [ -n "${CICDKIT_BASIC_USER:-}" ] && [ -n "${CICDKIT_BASIC_PASS:-}" ]; then
  AUTH=(-u "${CICDKIT_BASIC_USER}:${CICDKIT_BASIC_PASS}")
fi

need() { command -v "$1" >/dev/null || { echo "a2a-demo: 需要 $1" >&2; exit 1; }; }
need curl
need python3

pretty() { python3 -m json.tool; }

card() {
  curl -sS "${AUTH[@]}" "$BASE_URL/.well-known/agent-card.json"
}

rpc() {
  local payload="$1"
  curl -sS "${AUTH[@]}" \
    -H 'content-type: application/json' \
    --data-binary "$payload" \
    "$BASE_URL/a2a"
}

send() {
  local cap="${1:-cicd.overview}"
  local args="${2:-}"
  [ -n "$args" ] || args='{}'
  python3 -c 'import json,sys; v=json.loads(sys.argv[1]); assert isinstance(v, dict)' "$args" \
    || { echo "a2a-demo: args 必须是 JSON 对象，例如 '{\"limit\":3}'" >&2; exit 2; }
  local req_id="demo-$(date +%s)-$$"
  local payload
  payload="$(python3 - "$cap" "$args" "$req_id" <<'PY'
import json, sys
cap, args, req_id = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
print(json.dumps({
    "jsonrpc": "2.0",
    "id": req_id,
    "method": "message/send",
    "params": {
        "message": {
            "role": "user",
            "kind": "message",
            "messageId": req_id + "-msg",
            "parts": [{"kind": "text", "text": "查询 " + cap}],
        },
        "metadata": {"capability": cap, "args": args},
    },
}, ensure_ascii=False))
PY
)"
  rpc "$payload"
}

get_task() {
  local task_id="$1"
  local payload
  payload="$(python3 - "$task_id" <<'PY'
import json, sys
print(json.dumps({
    "jsonrpc": "2.0",
    "id": "get-" + sys.argv[1],
    "method": "tasks/get",
    "params": {"id": sys.argv[1]},
}, ensure_ascii=False))
PY
)"
  rpc "$payload"
}

show_card() {
  card | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("name        :", d.get("name"))
print("version     :", d.get("version"))
print("protocol    :", d.get("protocolVersion"))
print("url         :", d.get("url"))
print("streaming   :", d.get("capabilities", {}).get("streaming"))
print("skills      :")
for s in d.get("skills", []):
    print("  -", s.get("id"), "/", s.get("name"))
'
}

show_task() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
if "error" in d:
    e = d["error"]
    print("error       :", e.get("code"), e.get("message"))
    sys.exit(1)
r = d.get("result", {})
print("taskId      :", r.get("id"))
print("contextId   :", r.get("contextId"))
print("state       :", r.get("status", {}).get("state"))
print("capability  :", r.get("metadata", {}).get("capability"))
for a in r.get("artifacts", []):
    for p in a.get("parts", []):
        text = p.get("text", "")
        print("artifact    :", text[:240] + ("..." if len(text) > 240 else ""))
'
}

task_id_of() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
print(d.get("result", {}).get("id", ""))
'
}

demo() {
  echo "== agent card =="
  show_card

  echo
  echo "== message/send: cicd.overview =="
  local out1 tid
  out1="$(send cicd.overview '{}')"
  printf '%s' "$out1" | show_task
  tid="$(printf '%s' "$out1" | task_id_of)"

  if [ -n "$tid" ]; then
    echo
    echo "== tasks/get: $tid =="
    get_task "$tid" | show_task
  fi

  echo
  echo "== message/send: cicd.recent_runs {limit:3} =="
  send cicd.recent_runs '{"limit":3}' | show_task
}

usage() {
  cat <<'EOF'
用法：
  ./scripts/a2a_demo.sh demo
  ./scripts/a2a_demo.sh card
  ./scripts/a2a_demo.sh caps
  ./scripts/a2a_demo.sh send <capability> '<args-json>'
  ./scripts/a2a_demo.sh get <task_id>

环境变量：
  BASE_URL             默认 http://127.0.0.1:18107
  CICDKIT_BASIC_USER   未传时读仓库根 .env
  CICDKIT_BASIC_PASS   未传时读仓库根 .env
EOF
}

case "${1:-demo}" in
  demo) demo ;;
  card) show_card ;;
  caps) card | python3 -c 'import json,sys; print("\n".join(s["id"] for s in json.load(sys.stdin).get("skills", [])))' ;;
  send)
    [ $# -ge 2 ] || { usage; exit 2; }
    send "$2" "${3:-}" | pretty
    ;;
  get)
    [ $# -ge 2 ] || { usage; exit 2; }
    get_task "$2" | pretty
    ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
