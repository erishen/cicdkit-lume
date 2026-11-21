# cicdkit-lume — Makefile
#
#   make vendor   同步 lume 二进制 + lume-core/lib 到 vendor/
#   make check    lume --check 语法/类型校验
#   make ui       构建 React 控制台（esbuild → www/app.js）
#   make dev      check + ui + 前台启动（http://127.0.0.1:8096）
#   make run      只启动（假定 ui 已构建）
#   make stop     停掉本端口上的服务
#   make smoke    对运行中的服务做一次 HTTP 冒烟
#   make docker   构建镜像并起容器（127.0.0.1:18107）
#   make docker-logs / docker-down
#
# 上游 cicdkit 默认 http://127.0.0.1:8080；API Token 用 CICD_AUTH（或 CICD_AUTH_FILE）传入。

SHELL := /bin/bash
LUME  ?= vendor/lume/bin/lume
PORT  ?= 8096
CICD_BASE ?= http://127.0.0.1:8080

.PHONY: vendor check ui node_modules run dev stop smoke clean docker docker-logs docker-down

vendor:
	@bash scripts/vendor_lume.sh

check: vendor
	@$(LUME) --check cicdkit_lume.lume

node_modules: package.json
	@npm install --no-audit --no-fund

ui: node_modules
	@./node_modules/.bin/esbuild src/web/app.tsx --bundle --minify --format=esm --jsx=automatic --outfile=www/app.js
	@echo "✓ www/app.js 已构建"

run: ui
	@echo "▶ http://127.0.0.1:$(PORT)  (上游 $(CICD_BASE))"
	@LUME_PORT=$(PORT) CICD_BASE=$(CICD_BASE) $(LUME) cicdkit_lume.lume

dev: check ui
	@echo "▶ http://127.0.0.1:$(PORT)  (上游 $(CICD_BASE))"
	@LUME_PORT=$(PORT) CICD_BASE=$(CICD_BASE) $(LUME) cicdkit_lume.lume

stop:
	@pids=$$(lsof -ti tcp:$(PORT) 2>/dev/null || true); \
	if [ -n "$$pids" ]; then kill $$pids && echo "已停 $(PORT)"; else echo "$(PORT) 无监听进程"; fi

smoke:
	@bash scripts/smoke.sh http://127.0.0.1:$(PORT)

# 容器：http://127.0.0.1:18107，接入 cicdkit 容器的 cicdkit_default 网络。
docker:
	@docker compose up -d --build
	@echo "▶ http://127.0.0.1:18107"

docker-logs:
	@docker compose logs -f --tail=100

docker-down:
	@docker compose down

clean:
	@rm -f www/app.js
	@rm -rf node_modules
