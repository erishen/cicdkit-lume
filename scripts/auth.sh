#!/usr/bin/env bash
# 生成 Basic Auth 凭据（只在本机 ~/.config 下，不进仓库）。
#
#   make auth          # 已存在则不动
#   FORCE=1 make auth  # 重新生成（会同时换掉 Prometheus 的抓取口令）
#
# 产出三份文件：
#   htpasswd         Lume 的 HTPASSWD_FILE（bcrypt，只有哈希）
#   prometheus.pass  Prometheus basic_auth 的明文口令（只读挂进容器）
#   health-header    容器 HEALTHCHECK 用的 Basic base64 头
#
# 端口仍只绑 127.0.0.1；这层认证是给「以后改成对外监听」时兜底的。
set -euo pipefail

AUTH_DIR="${AUTH_DIR:-$HOME/.config/cicdkit-lume}"
USER_NAME="${AUTH_USER:-cicd}"
FORCE="${FORCE:-0}"

if [ "$FORCE" != "1" ] && [ -f "$AUTH_DIR/htpasswd" ] && [ -f "$AUTH_DIR/prometheus.pass" ] && [ -f "$AUTH_DIR/health-header" ]; then
  echo "auth: 已存在 ${AUTH_DIR}（FORCE=1 重新生成）"
  exit 0
fi

command -v htpasswd >/dev/null || { echo "auth: 需要 htpasswd（apache2-utils）" >&2; exit 1; }
umask 077
mkdir -p "$AUTH_DIR"
PASS="$(openssl rand -hex 24)"

htpasswd -nbB "${USER_NAME}" "$PASS" > "$AUTH_DIR/htpasswd"
printf '%s' "$PASS" > "$AUTH_DIR/prometheus.pass"
printf '%s:%s' "${USER_NAME}" "$PASS" | base64 | tr -d '\n' > "$AUTH_DIR/health-header"

chmod 600 "$AUTH_DIR/htpasswd" "$AUTH_DIR/health-header"
# Prometheus 容器以 nobody 运行，明文口令文件要可读（宿主目录仍 700）。
chmod 644 "$AUTH_DIR/prometheus.pass"
echo "auth: 已生成 ${AUTH_DIR}（用户 ${USER_NAME}，口令在 prometheus.pass）"
