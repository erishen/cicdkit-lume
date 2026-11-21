# syntax=docker/dockerfile:1
# cicdkit-lume —— Lume BFF + React 控制台镜像
#
# 两个阶段：
#   ui        node 里把 src/web/*.tsx 打包成 www/app.js（纯静态产物，平台无关）
#   runtime   alpine + lume 静态二进制 + 本项目 lume/docroot，一个进程就是整站
#            （静态文件 + SPA 回退 + 同源 JSON API），不需要 nginx / Node。
#
# lume 是静态链接的 C 单二进制。默认从已有的 lume 镜像里取（离线可用），
# 想换成自编版本：--build-arg LUME_BIN_IMAGE=<含 /usr/local/bin/lume 的镜像>。

ARG NODE_IMAGE=node:20-alpine
ARG LUME_BIN_IMAGE=windgl-china-lume:latest
ARG RUNTIME_IMAGE=alpine:3.20

# ---------- 阶段 1：React 控制台 ----------
FROM ${NODE_IMAGE} AS ui
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/web ./src/web
COPY www/index.html www/app.css ./www/
RUN npm run build

# ---------- 阶段 1b：只借 lume 二进制 ----------
FROM ${LUME_BIN_IMAGE} AS lume-bin

# ---------- 阶段 2：运行时 ----------
FROM ${RUNTIME_IMAGE} AS runtime
COPY --from=lume-bin /usr/local/bin/lume /usr/local/bin/lume

# 非 root 运行（uid 10001，与本家族其他 lume 服务一致）。
RUN addgroup -S -g 10001 lume \
 && adduser -S -D -H -u 10001 -G lume lume \
 && mkdir -p /app/www /app/.data

WORKDIR /app
# docroot（含 ui 阶段构建出的 app.js）
COPY --from=ui /web/www/ ./www/
# Lume 入口 + 业务模块（src/guard.lume 按路径 import vendor/lume-core/lib/*.lume）
COPY cicdkit_lume.lume ./
COPY src ./src
COPY vendor/lume-core ./vendor/lume-core
RUN chown -R 10001:10001 /app

# 上游默认指向同网络的 cicdkit 容器；端口固定 18107（宿主机侧由 compose 发布）。
ENV LUME_BIND=0.0.0.0 \
    LUME_PORT=18107 \
    CICD_BASE=http://cicdkit:8080

USER 10001
EXPOSE 18107

# 只看本进程是否在服务；上游掉线由 /api/health 的 ok 字段体现，不拖垮容器。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:18107/api/health >/dev/null || exit 1

CMD ["/usr/local/bin/lume", "cicdkit_lume.lume"]
