# cicdkit-lume — Makefile
#
#   make vendor   同步 lume 二进制 + lume-core/lib 到 vendor/
#   make check    lume --check 语法/类型校验（入口 + 所有模块）
#   make ui       构建 React 控制台（esbuild → www/app.js）
#   make test     存储 / 计划 / 闸门 三层自测（不碰真实 runner 与真实数据）
#   make runner   编 runner 并在宿主机启动（推荐：与 docker/kubectl 同机同路径）
#   make dev      check + ui + 前台启动控制面（http://127.0.0.1:8096）
#   make run      只启动（假定 ui 已构建）
#   make stop     停掉本端口上的服务
#   make smoke    对运行中的服务做一次 HTTP 冒烟
#   make plan     对着真实数据把每个项目的 argv 计划打出来（干跑）
#   make docker   构建镜像并起控制面 + runner（127.0.0.1:18107）
#   make docker-logs / docker-down
#
# cicdkit 已被取代：执行面是 runner/（Go，单二进制），不再有上游 HTTP 服务。
# 令牌用 RUNNER_AUTH（或 RUNNER_AUTH_FILE）传入，不能叫 RUNNER_TOKEN。

SHELL := /bin/bash
LUME  ?= vendor/lume/bin/lume
PORT  ?= 8096
WORK  ?= $(HOME)/Workspace
DATA  ?= ./.data
RUNNER_PORT ?= 8899
# 迁移过来的历史凭据目录（kubeconfig、ssh key）。项目配置里存的是它的宿主
# 绝对路径，容器必须按同一路径挂进来才认。
LEGACY ?= ../cicdkit/data-docker

.PHONY: vendor check ui node_modules runner runner-build run dev stop smoke test plan preflight remap remap-apply sanitize sanitize-apply migrate-args migrate-args-apply secret docker docker-logs docker-down clean

vendor:
	@bash scripts/vendor_lume.sh

check: vendor
	@for f in cicdkit_lume.lume src/*.lume scripts/*.lume; do $(LUME) --check $$f || exit 1; done
	@echo "✓ 全部模块语法通过"

node_modules: package.json
	@npm install --no-audit --no-fund

ui: node_modules
	@./node_modules/.bin/esbuild src/web/app.tsx --bundle --minify --format=esm --jsx=automatic --outfile=www/app.js
	@echo "✓ www/app.js 已构建"

# runner 在宿主机跑：docker.sock、kubectl、~/.ssh 都是现成的，
# 也不存在「容器内路径 ≠ 宿主路径」导致 docker build 找不到 context 的问题。
runner-build:
	@mkdir -p bin
	@cd runner && CGO_ENABLED=0 GOWORK=off go build -o ../bin/cicd-runner . && echo "✓ bin/cicd-runner"

runner: runner-build
	@echo "▶ runner 127.0.0.1:$(RUNNER_PORT)  日志 $(DATA)/logs"
	@RUNNER_BIND=127.0.0.1:$(RUNNER_PORT) RUNNER_LOG_DIR=$(DATA)/logs \
	 RUNNER_AUTH=$${RUNNER_AUTH:-devtoken} \
	 ./bin/cicd-runner

run: ui
	@echo "▶ 控制面 http://127.0.0.1:$(PORT)  (runner $(RUNNER_BASE))"
	@LUME_PORT=$(PORT) LUME_DATA=$(DATA) CICD_WORK_DIR=$(WORK) CICD_FS_ROOTS=$(WORK) \
	 RUNNER_BASE=$${RUNNER_BASE:-http://127.0.0.1:$(RUNNER_PORT)} \
	 RUNNER_AUTH=$${RUNNER_AUTH:-devtoken} \
	 $(LUME) cicdkit_lume.lume

dev: check ui
	@$(MAKE) run

stop:
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null || true); \
	if [ -n "$$pids" ]; then kill $$pids && echo "已停 $(PORT)"; else echo "$(PORT) 无监听进程"; fi

smoke:
	@bash scripts/smoke.sh http://127.0.0.1:$(PORT)

# 自测：存储 / 执行计划 / 生成 / A2A / 闸门（临时实例，不碰真实上游）+ runner go test。
runner-test:
	@cd runner && CGO_ENABLED=0 GOWORK=off go test ./... && echo "✓ runner go test 通过"

test: vendor
	@rm -rf /tmp/lume_test_store && mkdir -p /tmp/lume_test_store/logs && dd if=/dev/zero of=/tmp/lume_test_store/logs/run-big.log bs=1048576 count=17 2>/dev/null
	@LUME_DATA=/tmp/lume_test_store $(LUME) scripts/store_test.lume
	@rm -rf /tmp/lume_test_exec && LUME_DATA=/tmp/lume_test_exec RUNNER_BASE=http://127.0.0.1:9 $(LUME) scripts/exec_test.lume
	@rm -rf /tmp/lume_test_gen && LUME_DATA=/tmp/lume_test_gen $(LUME) scripts/generate_test.lume
	@rm -rf /tmp/lume_test_a2a && mkdir -p /tmp/lume_test_a2a && LUME_DATA=/tmp/lume_test_a2a CICDKIT_PEER_SHARED=test-shared $(LUME) scripts/a2a_test.lume
	@bash scripts/test_gate.sh "$(LUME)"
	@$(MAKE) runner-test

# 清洗项目配置里明文存放的密钥（LLM_API_KEY / *_VISIT_PIN 等）。
# 默认干跑：只列出「哪个项目的哪个字段会被改」，不打印任何明文；
# sanitize-apply 会先备份 store.db 再写库。清洗后依赖这些参数的构建会失效。
sanitize:
	@LUME_DATA=$(DATA) $(LUME) scripts/sanitize_secrets.lume

sanitize-apply:
	@cp $(DATA)/store.db $(DATA)/store.db.bak.$$(date +%Y%m%d%H%M%S)
	@LUME_DATA=$(DATA) APPLY=1 $(LUME) scripts/sanitize_secrets.lume
	@ls -1 $(DATA)/store.db.bak.* | tail -1

# build_args 里的 `********` → `secret:<名字>` 引用（真实值放 $(DATA)/secrets/）。
# 默认干跑；apply 前先备份 store.db。之后用 make secret 把值写回去。
migrate-args:
	@LUME_DATA=$(DATA) $(LUME) scripts/migrate_build_args.lume

migrate-args-apply:
	@cp $(DATA)/store.db $(DATA)/store.db.bak.$$(date +%Y%m%d%H%M%S)
	@LUME_DATA=$(DATA) APPLY=1 $(LUME) scripts/migrate_build_args.lume

# 写入一个构建密钥：make secret NAME=lume_crm_llm_api_key VALUE=sk-...
# 文件落在 $(DATA)/secrets/<名字>，目录 0700；值不进项目配置、不进 argv、不进日志。
secret:
	@test -n "$(NAME)" || (echo "用法：make secret NAME=<名字> VALUE=<值>" >&2; exit 2)
	@test -n "$(VALUE)" || (echo "VALUE 为空，拒绝写入" >&2; exit 2)
	@mkdir -p $(DATA)/secrets && chmod 700 $(DATA)/secrets
	@umask 077; printf '%s\n' '$(VALUE)' > $(DATA)/secrets/$(NAME)
	@echo "✓ 已写入 $(DATA)/secrets/$(NAME)"

# 运行历史归档（CICD_RUN_KEEP 收走的那些），可列出、可恢复。
archive:
	@LUME_DATA=$(DATA) $(LUME) scripts/archive_admin.lume

restore:
	@test -n "$(ID)" || (echo "用法：make restore ID=<run_id>" >&2; exit 2)
	@out=$$(LUME_DATA=$(DATA) ACTION=restore RUN_ID=$(ID) $(LUME) scripts/archive_admin.lume); echo "$$out"; case "$$out" in 恢复失败*) exit 1;; esac

# 切换前体检：build.context / Dockerfile / kubeconfig / ssh key 在本机上是否真的存在。
# 有阻断项返回非 0。容器视角的路径映射用 remap / remap-apply（见 README）。
preflight:
	@bash scripts/preflight.sh

remap:
	@LUME_DATA=$(DATA) $(LUME) scripts/remap_paths.lume

remap-apply:
	@cp $(DATA)/store.db $(DATA)/store.db.bak.$$(date +%Y%m%d%H%M%S)
	@LUME_DATA=$(DATA) APPLY=1 $(LUME) scripts/remap_paths.lume

# 干跑：把真实项目配置翻译成 argv，先看一遍再动手。
plan:
	@LUME_DATA=$(DATA) $(LUME) scripts/plan_dump.lume

# 容器：http://127.0.0.1:18107（控制面）+ 内网 runner（不映射端口）。
.data/runner.token:
	@mkdir -p .data && umask 077 && openssl rand -hex 24 > $@

docker: .data/runner.token
	@RUNNER_AUTH=$$(cat .data/runner.token) PROJECTS_ROOT=$(WORK) LEGACY_DATA=$(abspath $(LEGACY)) \
	 CICD_DEFAULT_KUBECONFIG=$(abspath $(LEGACY)/kubeconfig-cicd) \
	 docker compose up -d --build
	@echo "▶ http://127.0.0.1:18107"

docker-logs: .data/runner.token
	@RUNNER_AUTH=$$(cat .data/runner.token) PROJECTS_ROOT=$(WORK) LEGACY_DATA=$(abspath $(LEGACY)) \
	 docker compose logs -f --tail=100

docker-down: .data/runner.token
	@RUNNER_AUTH=$$(cat .data/runner.token) PROJECTS_ROOT=$(WORK) LEGACY_DATA=$(abspath $(LEGACY)) \
	 docker compose down

clean:
	@rm -f www/app.js bin/cicd-runner
	@rm -rf node_modules
