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
# 可选：独立的终审账号。生产发布要求「发起人 ≠ 审批人」，单账号会被拦；
# 配了这组变量后 htpasswd / accounts.json 会同时包含两个 Basic Auth 用户。
APPROVER_USER="${CICDKIT_APPROVER_USER:-}"
APPROVER_PASS="${CICDKIT_APPROVER_PASS:-}"
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

if [ -n "$APPROVER_USER" ] && [ -z "$APPROVER_PASS" ]; then
  if [ -f "$ENV_FILE" ] && grep -q '^CICDKIT_APPROVER_PASS=' "$ENV_FILE"; then
    echo "auth: .env 里 CICDKIT_APPROVER_PASS 为空，请填一个口令后重试" >&2
    exit 1
  fi
  APPROVER_PASS="$(openssl rand -hex 24)"
  umask 077
  printf "CICDKIT_APPROVER_USER='%s'\n" "$APPROVER_USER" >> "$ENV_FILE"
  printf "CICDKIT_APPROVER_PASS='%s'\n" "$APPROVER_PASS" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "auth: 已在 .env 生成独立终审账号口令"
fi

# 身份绑定账号表：只在不存在时生成，之后由用户手改（角色、多人账号）。
# 与 kb-abac 一样，Basic Auth 用户是身份，roles 是本地授权，不做自报角色。
if [ ! -f "$AUTH_DIR/accounts.json" ]; then
  umask 077
  mkdir -p "$AUTH_DIR"
  cat > "$AUTH_DIR/accounts.json" <<EOF
{
  "accounts": {
    "$USER_NAME": {
      "roles": ["agent_operator", "human_admin"],
      "title": "Basic Auth user"
    }
  }
}
EOF
  chmod 600 "$AUTH_DIR/accounts.json"
  echo "auth: 已生成 $AUTH_DIR/accounts.json（${USER_NAME}: 操作员 + 终审）"
fi

# 已有账号表时只补终审账号，不改主账号已有角色；这样老部署升级不会丢权限。
if [ -n "$APPROVER_USER" ] && [ -f "$AUTH_DIR/accounts.json" ]; then
  python3 - "$AUTH_DIR/accounts.json" "$APPROVER_USER" <<'PYACCOUNTS'
import json, sys
path, user = sys.argv[1], sys.argv[2]
with open(path) as f:
    root = json.load(f)
accounts = root.setdefault("accounts", {})
if user not in accounts:
    accounts[user] = {"roles": ["human_admin"], "title": "Independent approver"}
    with open(path, "w") as f:
        json.dump(root, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"auth: accounts.json 已补独立终审账号 {user}")
PYACCOUNTS
  chmod 600 "$AUTH_DIR/accounts.json"
fi

# 资源/动作白名单：首次从默认表生成；已有文件只补新增资源，不覆盖人工改过的条目。
# 默认表带 defaults_version：版本追平后不再自动补，管理员删掉的默认资源不会被加回。
RES_DEFAULT="$ROOT/scripts/resources.default.json"
if [ ! -f "$AUTH_DIR/resources.json" ]; then
  umask 077
  mkdir -p "$AUTH_DIR"
  cp "$RES_DEFAULT" "$AUTH_DIR/resources.json"
  chmod 600 "$AUTH_DIR/resources.json"
  echo "auth: 已生成 $AUTH_DIR/resources.json"
else
  python3 "$ROOT/scripts/merge_resources.py" "$AUTH_DIR/resources.json" "$RES_DEFAULT"
  chmod 600 "$AUTH_DIR/resources.json" 2>/dev/null || true
fi

command -v htpasswd >/dev/null || { echo "auth: 需要 htpasswd（apache2-utils）" >&2; exit 1; }

NEED=0
[ -f "$AUTH_DIR/htpasswd" ] || NEED=1
[ "$(cat "$AUTH_DIR/prometheus.pass" 2>/dev/null || true)" = "$PASS" ] || NEED=1
[ "$(cat "$AUTH_DIR/username" 2>/dev/null || true)" = "$USER_NAME" ] || NEED=1
if [ -n "$APPROVER_USER" ]; then
  grep -q "^${APPROVER_USER}:" "$AUTH_DIR/htpasswd" 2>/dev/null || NEED=1
  [ "$(cat "$AUTH_DIR/approver.pass" 2>/dev/null || true)" = "$APPROVER_PASS" ] || NEED=1
fi
if [ "$FORCE" != "1" ] && [ "$NEED" = "0" ]; then
  echo "auth: 凭据未变化（${AUTH_DIR}）"
  exit 0
fi

umask 077
mkdir -p "$AUTH_DIR"
htpasswd -nbB "$USER_NAME" "$PASS" | sed '/^$/d' > "$AUTH_DIR/htpasswd"
if [ -n "$APPROVER_USER" ]; then
  htpasswd -nbB "$APPROVER_USER" "$APPROVER_PASS" | sed '/^$/d' >> "$AUTH_DIR/htpasswd"
fi
printf '%s' "$USER_NAME" > "$AUTH_DIR/username"
printf '%s' "$PASS" > "$AUTH_DIR/prometheus.pass"
if [ -n "$APPROVER_USER" ]; then printf '%s' "$APPROVER_PASS" > "$AUTH_DIR/approver.pass"; fi
printf '%s:%s' "$USER_NAME" "$PASS" | base64 | tr -d '\n' > "$AUTH_DIR/health-header"

chmod 600 "$AUTH_DIR/htpasswd" "$AUTH_DIR/health-header"
if [ -n "$APPROVER_USER" ]; then chmod 600 "$AUTH_DIR/approver.pass"; fi
# 容器内的 Prometheus / 健康检查以非 root 读这两份，需要放宽到 644；
# 宿主目录仍是 700，其他本机用户进不来。
chmod 644 "$AUTH_DIR/prometheus.pass" "$AUTH_DIR/username"
echo "auth: 已生成 ${AUTH_DIR}（用户 ${USER_NAME}，口令来自 .env）"
