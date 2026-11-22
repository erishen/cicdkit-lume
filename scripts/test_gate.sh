#!/usr/bin/env bash
# scripts/test_gate.sh —— 起一个临时实例验证控制面自己的行为（不依赖 cicdkit，也不依赖 runner）
#
# 覆盖：
#   1) 发布闸门：无 role / 错角色 → 403，且响应里带审批链
#   2) 闸门放行后项目不存在 → 404（证明请求真的进了本地存储层，而不是转发给谁）
#   3) 目录浏览 / 改配置 / 清数据同级门禁：无 role → 403
#   4) 首屏聚合 runner 不可达 → 200 + connected:false（快速降级，不是 500）
#   5) 健康检查 runner 不可达 → HTTP 200 + ok:false（容器探针不会误判进程死亡）
#   6) 新建 / 删除项目走本地库：无 role 403、有 role 200
#   7) 静态站不受影响
#
# RUNNER_BASE 指向 127.0.0.1:9（discard，连接立即被拒），LUME_DATA 用临时目录，
# 全程不碰真实数据。端口挑一个未被占用的高位端口。
#
# 用法: bash scripts/test_gate.sh [lume 二进制路径]

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LUME="${1:-$ROOT/vendor/lume/bin/lume}"
DEAD_RUNNER="http://127.0.0.1:9"

fail=0
ok() { echo "✓ $*"; }
ng() { echo "✗ $*" >&2; fail=1; }

if [ ! -x "$LUME" ]; then
  echo "✗ 缺少 lume 二进制：${LUME}（先跑 make vendor）" >&2
  exit 1
fi

PORT=""
for p in $(seq 18099 18160); do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN -t >/dev/null 2>&1; then PORT="$p"; break; fi
done
[ -n "$PORT" ] || { echo "✗ 18099-18160 都被占用，没有空闲端口" >&2; exit 1; }
BASE="http://127.0.0.1:$PORT"

DATA="$(mktemp -d -t cicdkit-lume-test)"
LOG="$(mktemp -t cicdkit-lume-test-log)"
cd "$ROOT" || exit 1
LUME_DATA="$DATA" RUNNER_BASE="$DEAD_RUNNER" CICD_DEPLOY_APPROVAL=approve CICD_HOOK_KEY=testkey \
  CICD_WORK_DIR="$DATA" CICD_FS_ROOTS="$DATA" \
  LUME_BIND=127.0.0.1 LUME_PORT="$PORT" \
  "$LUME" cicdkit_lume.lume >"$LOG" 2>&1 &
LUME_PID=$!
# lume 是多进程（主进程 + worker），只 SIGTERM 主进程时它要等 worker，收尾会卡住；
# 这里直接硬杀，并按端口兜底清掉残留 worker。
cleanup() {
  kill -9 "$LUME_PID" 2>/dev/null
  wait "$LUME_PID" 2>/dev/null || true
  for pid in $(lsof -ti tcp:"$PORT" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
  rm -rf "$DATA" "$LOG"
}
trap cleanup EXIT

up=0
for _ in $(seq 1 40); do
  if curl -s -m 2 -o /dev/null "$BASE/"; then up=1; break; fi
  sleep 0.25
done
[ "$up" = 1 ] || { echo "✗ 临时实例 10s 内没起来，日志：${LOG}" >&2; sed -n '1,20p' "${LOG}" >&2; exit 1; }

CODE=""
BODY=""
# call <METHOD> <PATH> [BODY]
call() {
  local method="$1" path="$2" body="${3:-}" out
  if [ -n "$body" ]; then
    out="$(curl -s -m 10 -X "$method" -H 'Content-Type: application/json' -d "$body" -w '\n%{http_code}' "$BASE$path" 2>/dev/null)"
  else
    out="$(curl -s -m 10 -X "$method" -w '\n%{http_code}' "$BASE$path" 2>/dev/null)"
  fi
  CODE="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

expect_code() { # <期望> <说明>
  if [ "${CODE}" = "$1" ]; then ok "$2 → ${CODE}"; else ng "$2 → ${CODE}（期望 $1）：${BODY}"; fi
}

expect_body() { # <固定子串> <说明>
  case "$BODY" in
    *"$1"*) ok "$2" ;;
    *) ng "$2（响应里没有「$1」）：${BODY}" ;;
  esac
}

expect_absent() {
  case "$BODY" in
    *"$1"*) ng "$2（不该出现「$1」）：${BODY}" ;;
    *) ok "$2" ;;
  esac
}

echo "▶ 临时实例 ${BASE} （runner ${DEAD_RUNNER}，闸门 approve，数据 ${DATA}）"

# 1) 发布闸门
call POST "/api/projects/p1/deploy"
expect_code 403 "发布：未声明 role 被拦"
expect_body '"allowed":false' "发布：返回闸门结构"
expect_body '"chain"' "发布：附审批链"

call POST "/api/projects/p1/deploy?role=agent_operator"
expect_code 403 "发布：操作员不能 approve"

# 2) 放行后进本地存储：项目不存在 → 404，而不是转发给上游的 502
call POST "/api/projects/p1/deploy?role=human_admin"
expect_code 404 "发布：放行后按本地库判定（项目不存在）"
expect_body '项目不存在' "发布：404 说明来源"
expect_absent 'cicdkit 上游' "发布：没有残留的上游代理错误"

# 2.1) 回滚：和发布同一个审批闸门，没有历史时明确 400 而不是 500
call POST "/api/projects/p1/rollback"
expect_code 403 "回滚：未声明 role 被拦"
call POST "/api/projects/nope/rollback?role=human_admin"
expect_code 404 "回滚：项目不存在 → 404"
# 具体项目的"没有历史"分支放在 gate-hook 建好之后（p1 并不存在）

# 3) 门禁一致性
call GET "/api/fs/roots"
expect_code 403 "目录浏览：未声明 role 被拦"
call GET "/api/fs/roots?role=human_admin"
expect_code 200 "目录浏览：放行后读本地根目录"
expect_body '"roots"' "目录浏览：返回根列表"

call PUT "/api/config/llm"
expect_code 403 "LLM 配置：未声明 role 被拦"
call DELETE "/api/runs"
expect_code 403 "清空运行：未声明 role 被拦"
call GET "/api/runs/archive"
expect_code 200 "归档列表：不要求 role，可直接读"
expect_body '"entries"' "归档列表：返回 entries（没被 /api/runs/:id 吃掉）"
call POST "/api/runs/arc-gate/restore"
expect_code 403 "恢复归档：未声明 role 被拦"
call POST "/api/runs/arc-gate/restore?role=human_admin"
expect_code 404 "恢复归档：不存在的运行 → 404 而不是 500"
call DELETE "/api/deployments"
expect_code 403 "清空部署：未声明 role 被拦"
call POST "/api/kb"
expect_code 403 "写知识库：未声明 role 被拦"

# 4) 首屏聚合：runner 不可达也要快速返回
call GET "/api/overview"
expect_code 200 "总览：降级后仍是正常响应"
expect_body '"connected":false' "总览：标出 runner 未连接"

# 5) 探针只看本进程
call GET "/api/health"
expect_code 200 "健康：本进程仍在服务"
expect_body '"runner_ok":false' "健康：runner 不可达体现在 runner_ok 字段"
expect_body '"upstream_status":0' "健康：runner 不可达时不再谎报 200"

# 6) 新建 / 删除走本地库
call POST "/api/projects"
expect_code 403 "新建项目：未声明 role 被拦"
call POST "/api/projects?role=human_admin" '{"id":"gate-demo","name":"gate demo","build":{"context":"'"$DATA"'","image_repo":"local/gate-demo"},"deploy":{"method":"ssh","ssh_host":"10.0.0.9","ssh_user":"root"}}'
expect_code 200 "新建项目：human_admin 放行"
expect_body '"id":"gate-demo"' "新建项目：返回落库后的对象"
call GET "/api/projects/gate-demo"
expect_code 200 "读取项目：新建后可见"
call DELETE "/api/projects/gate-demo?role=human_admin"
expect_code 200 "删除项目：human_admin 放行"

# 7) webhook / 生成脚手架前重建一个临时项目（上一个已被删除用例清掉）
call POST "/api/projects?role=human_admin" '{"id":"gate-hook","name":"gate hook","build":{"context":"'"$DATA"'","image_repo":"local/gate-hook"},"deploy":{"method":"ssh","ssh_host":"10.0.0.9","ssh_user":"root"}}'
expect_code 200 "重建临时项目：human_admin 放行 → 200"

# 7.1) webhook：机器调用，不参与角色闸门，只认自己的 key
call POST "/api/projects/gate-hook/rollback?role=human_admin"
expect_code 400 "回滚：没有发布历史 → 400 而不是 500"
expect_body '回滚' "回滚：错误说明指向回滚"
call GET "/api/projects/gate-hook/deploy-versions"
expect_code 200 "版本列表：没有历史时返回空列表"
expect_body '"total":0' "版本列表：total 为 0"
call GET "/api/projects/nope/deploy-versions"
expect_code 404 "版本列表：项目不存在 → 404"
call POST "/api/projects/gate-hook/rollback?role=human_admin" '{"image_ref":"ghost:latest"}'
expect_code 400 "回滚：镜像不在发布历史里被拒"
expect_body '发布历史' "回滚：拒绝理由指向发布历史"

call POST "/api/webhook/gate-hook"
expect_code 401 "webhook：缺 secret 被拒"
call POST "/api/webhook/gate-hook?secret=wrong"
expect_code 401 "webhook：错 secret 被拒"
call POST "/api/webhook/nope?secret=testkey"
expect_code 404 "webhook：项目不存在"
call POST "/api/webhook/gate-hook?secret=testkey" '{"tag":"bad tag; rm -rf /"}'
expect_code 400 "webhook：非法 tag 被拒"
call POST "/api/webhook/gate-hook?secret=testkey"
expect_code 400 "webhook：key 对但 runner 不可达（不静默成功）"
expect_body 'runner' "webhook：错误说明指向 runner"

# 8) 脚手架生成：与写操作同级门禁；临时项目没语言标记 → 明确报错而不是乱生成
call POST "/api/projects/gate-hook/generate"
expect_code 403 "生成脚手架：未声明 role 被拦"
call POST "/api/projects/gate-hook/generate?role=human_admin"
expect_code 400 "生成脚手架：无法识别语言时明确失败"
expect_body '无法识别项目语言' "生成脚手架：错误说明原因"
call POST "/api/projects/nope/generate?role=human_admin"
expect_code 404 "生成脚手架：项目不存在"

# 8.1) 真跑一次落盘：临时 go 项目 → 预览不写、apply 才写、二次幂等
mkdir -p "$DATA/gate-src"
printf 'module gate\n' > "$DATA/gate-src/go.mod"
call POST "/api/projects?role=human_admin" '{"id":"gate-gen","name":"gate gen","build":{"context":"'"$DATA"'/gate-src"},"deploy":{"method":"local-k3s","container_port":8090}}'
expect_code 200 "生成脚手架：准备 go 项目 → 200"
call POST "/api/projects/gate-gen/generate?role=human_admin"
expect_code 200 "生成脚手架：预览 → 200"
expect_body '"needs_any":true' "生成脚手架：预览标出待补文件"
if [ -f "$DATA/gate-src/Dockerfile" ]; then fail=$((fail+1)); echo "✗ 生成脚手架：预览不应落盘"; else ok "生成脚手架：预览不落盘"; fi
call POST "/api/projects/gate-gen/generate?role=human_admin&apply=1"
expect_code 200 "生成脚手架：apply → 200"
if [ -f "$DATA/gate-src/Dockerfile" ] && [ -f "$DATA/gate-src/k8s/deployment.yaml" ]; then ok "生成脚手架：两个文件已落盘"; else fail=$((fail+1)); echo "✗ 生成脚手架：文件没写出来"; fi
call POST "/api/projects/gate-gen/generate?role=human_admin"
expect_body '"needs_any":false' "生成脚手架：二次调用幂等"

# 8.2) 目录浏览的根目录校验：前缀越界与 .. 逃逸都必须 403
call GET "/api/fs/list?dir=${DATA}/../etc"
expect_code 403 "目录浏览：.. 逃逸被拒"
call GET "/api/fs/list?dir=${DATA}x"
expect_code 403 "目录浏览：同前缀兄弟目录被拒"

# 9) 静态站
call GET "/"
expect_code 200 "静态：index.html 正常伺服"

echo
if [ "$fail" = 0 ]; then echo "全部通过"; else echo "有失败项" >&2; fi
exit "$fail"
