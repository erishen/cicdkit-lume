#!/usr/bin/env bash
# scripts/test_gate.sh —— 起一个临时 Lume 实例（上游故意指向死端口），验证本层自己的行为：
#
#   1) 审批闸门：无 role / 错角色 → 403，且响应里带审批链
#   2) 合法角色放行后上游不可达 → 502（不是 500，也不是静默空数据）
#   3) 只读但会暴露服务器目录的接口（/api/fs/*）同样要求 human_admin
#   4) /api/overview 上游不可达 → 快速降级成 connected:false + errors 原因
#   5) /api/health 上游不可达 → HTTP 200 + ok:false（容器探针不会误判进程死亡）
#
# 全程不碰真实 cicdkit：CICD_BASE 指向 127.0.0.1:9（discard，连接立即被拒），
# 闸门用 approve，端口挑一个未被占用的高位端口。
#
# 用法: bash scripts/test_gate.sh [lume 二进制路径]

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LUME="${1:-$ROOT/vendor/lume/bin/lume}"
DEAD_UPSTREAM="http://127.0.0.1:9"

fail=0
ok() { echo "✓ $*"; }
ng() { echo "✗ $*" >&2; fail=1; }

if [ ! -x "$LUME" ]; then
  echo "✗ 缺少 lume 二进制：${LUME}（先跑 make vendor）" >&2
  exit 1
fi

# 挑一个空闲端口（避开 8096 / 18107 这些常用端口范围的低段）。
PORT=""
for p in $(seq 18099 18160); do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1; then PORT="$p"; break; fi
done
[ -n "$PORT" ] || { echo "✗ 18099-18160 都被占用，没有空闲端口" >&2; exit 1; }
BASE="http://127.0.0.1:$PORT"

LOG="$(mktemp -t cicdkit-lume-test)"
cd "$ROOT" || exit 1
CICD_BASE="$DEAD_UPSTREAM" CICD_DEPLOY_APPROVAL=approve \
  LUME_BIND=127.0.0.1 LUME_PORT="$PORT" \
  "$LUME" cicdkit_lume.lume >"$LOG" 2>&1 &
LUME_PID=$!
trap 'kill "$LUME_PID" 2>/dev/null; wait "$LUME_PID" 2>/dev/null; rm -f "$LOG"' EXIT

# 等服务起来（最多 10s）。健康检查在死上游下也是 200，所以看连通性而不是 ok 字段。
up=0
for _ in $(seq 1 40); do
  if curl -s -m 2 -o /dev/null "$BASE/"; then up=1; break; fi
  sleep 0.25
done
[ "$up" = 1 ] || { echo "✗ 临时实例 10s 内没起来，日志：$LOG" >&2; sed -n '1,20p' "$LOG" >&2; exit 1; }

# call <METHOD> <PATH> → CODE / BODY
CODE=""
BODY=""
call() {
  local out
  out="$(curl -s -m 10 -X "$1" -w '\n%{http_code}' "$BASE$2" 2>/dev/null)"
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

expect_code() { # <期望> <说明>
  if [ "$CODE" = "$1" ]; then ok "$2 → $CODE"; else ng "$2 → ${CODE}（期望 $1）：$BODY"; fi
}

expect_body() { # <fixed 字符串> <说明>
  case "$BODY" in
    *"$1"*) ok "$2" ;;
    *) ng "$2（响应里没有「$1」）：$BODY" ;;
  esac
}

echo "▶ 临时实例 http://127.0.0.1:$PORT （上游 ${DEAD_UPSTREAM}，闸门 approve）"

# 1) 发布闸门
call POST "/api/projects/p1/deploy"
expect_code 403 "发布：未声明 role 被拦"
expect_body '"allowed":false' "发布：返回闸门结构"
expect_body '"chain"' "发布：附审批链"

call POST "/api/projects/p1/deploy?role=agent_operator"
expect_code 403 "发布：操作员不能 approve"

# 2) 合法角色放行后，上游不可达 → 502（证明闸门之后真的走到了代理层）
call POST "/api/projects/p1/deploy?role=human_admin"
expect_code 502 "发布：终审放行（上游不可达）"
expect_body '无法连接 cicdkit 上游' "发布：502 带上游原因"

# 3) 目录浏览与改配置同级
call GET "/api/fs/roots"
expect_code 403 "目录浏览：未声明 role 被拦"

call GET "/api/fs/roots?role=human_admin"
expect_code 502 "目录浏览：放行后上游不可达"

# 4) 首屏聚合快速降级
call GET "/api/overview"
expect_code 200 "总览：降级后仍是正常响应"
expect_body '"connected":false' "总览：标出上游未连接"
expect_body '"errors"' "总览：给出每个数据源的原因"

# 5) 探针只看本进程
call GET "/api/health"
expect_code 200 "健康：本进程仍在服务"
expect_body '"ok":false' "健康：上游不可达体现在 ok 字段"

# 6) 静态站不受影响
call GET "/"
expect_code 200 "静态：index.html 正常伺服"

echo
if [ "$fail" = 0 ]; then echo "全部通过"; else echo "有失败项" >&2; fi
exit "$fail"
