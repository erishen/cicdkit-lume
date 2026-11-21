#!/usr/bin/env bash
# scripts/preflight.sh —— 切换前的「这些配置在你机器上真的能跑吗」体检
#
# 迁移过来的项目里，路径/密钥/kubeconfig 都是 cicdkit 容器内的视角
# （/workspace/...、/app/data/ssh_tencent_key）。控制面换成宿主机 runner 后，
# 这些路径必须在你本机上真的存在，否则构建会在第一步就失败。
#
# 检查项：
#   1) build.context 目录是否存在         → 不存在则 docker build 找不到上下文
#   2) build.dockerfile 是否存在
#   3) kubectl 系部署的 kubeconfig        → deploy.kubeconfig / KUBECONFIG / CICD_DEFAULT_KUBECONFIG
#   4) ssh 系部署的 ssh_key_path          → 每个 target 各查一次
#
# 用法：
#   bash scripts/preflight.sh                 # 默认读 ./.data/store.db
#   bash scripts/preflight.sh path/to/store.db
#
# 退出码：有阻断项 → 1，否则 0（警告不影响退出码）。

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${1:-$ROOT/.data/store.db}"

if [ ! -f "$DB" ]; then
  echo "✗ 找不到 $DB（先跑一次控制面完成迁移，或 make sanitize 触发导入）" >&2
  exit 1
fi

python3 - "$DB" <<'PY'
import json, os, sqlite3, sys

db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
rows = con.execute("SELECT id, name, json FROM projects ORDER BY id").fetchall()

blockers = 0
warns = 0

def ok(msg):   print(f"  ✓ {msg}")
def bad(msg):
    global blockers
    blockers += 1
    print(f"  ✗ {msg}")
def warn(msg):
    global warns
    warns += 1
    print(f"  ! {msg}")

def check_path(path, what):
    if not path:
        bad(f"{what} 为空")
        return
    if os.path.exists(path):
        ok(f"{what} {path}")
    else:
        bad(f"{what} 不存在：{path}")

print(f"preflight: {len(rows)} project(s) ← {db}")

for pid, name, raw in rows:
    p = json.loads(raw) if raw else {}
    print(f"\n[{name or pid}]")

    build = p.get("build") or {}
    check_path(build.get("context"), "build.context")
    if build.get("dockerfile"):
        check_path(build.get("dockerfile"), "build.dockerfile")
    else:
        warn("build.dockerfile 未配置，会用 <context>/Dockerfile")

    # 部署：顶层 deploy 与 targets 各查一遍
    cands = []
    if p.get("deploy"):
        cands.append(("deploy", p["deploy"]))
    for i, t in enumerate(p.get("targets") or []):
        cands.append((f"targets[{i}]({t.get('name','')})", t))

    if not cands:
        warn("没有任何部署目标（只能构建/发布镜像）")

    for label, spec in cands:
        method = (spec.get("method") or "").strip()
        if method in ("kubectl", "helm", "local-k3s"):
            kc = spec.get("kubeconfig") or os.environ.get("KUBECONFIG") or os.environ.get("CICD_DEFAULT_KUBECONFIG")
            if not kc:
                bad(f"{label} 是 {method}，但 kubeconfig 三个来源都为空")
            elif os.path.exists(kc):
                ok(f"{label} kubeconfig {kc}")
            else:
                bad(f"{label} kubeconfig 不存在：{kc}")
        elif method == "ssh":
            check_path(spec.get("ssh_key_path"), f"{label} ssh_key_path")
        elif method == "":
            warn(f"{label} method 为空（迁移时没落库？）")

print()
if blockers:
    print(f"结果：{blockers} 个阻断项、{warns} 个提醒 —— 这些不修，动作会在第一步失败")
    sys.exit(1)
print(f"结果：无阻断项（{warns} 个提醒）")
PY
