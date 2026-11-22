#!/usr/bin/env bash
# 从 .env 读取用户名/口令，生成 Basic Auth 需要的派生文件。
#
#   make auth          # .env 改了会自动重建；没变则跳过
#   FORCE=1 make auth  # 强制重建（会换掉 Prometheus 的抓取口令）
#
# .env（已 gitignore）是唯一事实来源：
#   CICDKIT_BASIC_USER=cicd
#   CICDKIT_BASIC_PASS=...
#
# 派生到 ~/.config/cicdkit-lume（不进仓库，供容器只读挂载）：
#   htpasswd         Lume 的 HTPASSWD_FILE（bcrypt，只有哈希）
#   username         Prometheus basic_auth 的用户名
#   prometheus.pass  Prometheus basic_auth 的明文口令
#   health-header    容器 HEALTHCHECK 用的 Basic base64 头
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
AUTH_DIR="${AUTH_DIR:-$HOME/.config/cicdkit-lume}"
FORCE="${FORCE:-0}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

USER_NAME="${CICDKIT_BASIC_USER:-cicd}"
PASS="${CICDKIT_BASIC_PASS:-}"
if [ -z "$PASS" ]; then
  if [ -f "$ENV_FILE" ] && grep -q '^CICDKIT_BASIC_PASS=' "$ENV_FILE"; then
    echo "auth: .env 里 CICDKIT_BASIC_PASS 为空，请填一个口令后重试" >&2
    exit 1
  fi
  PASS="$(openssl rand -hex 24)"
  umask 077
  { [ -f "$ENV_FILE" ] || printf '# 本机配置（已被 .gitignore 忽略，不要入库）\n' > "$ENV_FILE";
    printf "CICDKIT_BASIC_USER='%s'\n" "$USER_NAME";
    printf "CICDKIT_BASIC_PASS='%s'\n" "$PASS";
  } >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "auth: 已在 .env 生成用户名/口令"
fi

command -v htpasswd >/dev/null || { echo "auth: 需要 htpasswd（apache2-utils）" >&2; exit 1; }

NEED=0
[ -f "$AUTH_DIR/htpasswd" ] || NEED=1
[ "$(cat "$AUTH_DIR/prometheus.pass" 2>/dev/null || true)" = "$PASS" ] || NEED=1
[ "$(cat "$AUTH_DIR/username" 2>/dev/null || true)" = "$USER_NAME" ] || NEED=1
if [ "$FORCE" != "1" ] && [ "$NEED" = "0" ]; then
  echo "auth: 凭据未变化（${AUTH_DIR}）"
  exit 0
fi

umask 077
mkdir -p "$AUTH_DIR"
htpasswd -nbB "$USER_NAME" "$PASS" > "$AUTH_DIR/htpasswd"
printf '%s' "$USER_NAME" > "$AUTH_DIR/username"
printf '%s' "$PASS" > "$AUTH_DIR/prometheus.pass"
printf '%s:%s' "$USER_NAME" "$PASS" | base64 | tr -d '\n' > "$AUTH_DIR/health-header"

chmod 600 "$AUTH_DIR/htpasswd" "$AUTH_DIR/health-header"
# 容器内的 Prometheus / 健康检查以非 root 读这两份，需要放宽到 644；
# 宿主目录仍是 700，其他本机用户进不来。
chmod 644 "$AUTH_DIR/prometheus.pass" "$AUTH_DIR/username"
echo "auth: 已生成 ${AUTH_DIR}（用户 ${USER_NAME}，口令来自 .env）"
