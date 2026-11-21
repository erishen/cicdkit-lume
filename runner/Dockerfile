# syntax=docker/dockerfile:1
# cicdkit runner —— 只按 argv 执行并流式写日志的内网执行器
#
# 它没有业务逻辑：不拼命令行、不判断发布策略、不碰 HTTP 之外的控制面状态。
# 所有「发什么」都由控制面（lume DSL）决定，这里只负责「跑」。
#
# 关键约束（照抄 main.go 的设计）：
#   * 只监听内网，不映射到宿主机公网端口；对外只暴露 X-Runner-Token。
#   * argv[0] 走白名单（默认 docker,kubectl,ssh,helm,git,scp,sudo），不解释 shell。
#   * 日志目录必须与控制面的 LUME_DATA/logs 是同一个目录（按字节偏移增量读）。
#
# 路径陷阱：runner 用宿主 docker daemon 执行 `docker build <context>` 时，
# daemon 解析的是**宿主机**路径。若把 runner 放进容器，就必须把项目目录
# 以「相同绝对路径」挂进来（-v /Users/erishen/Workspace:/Users/erishen/Workspace），
# 否则 docker 会报 context 不存在。本地开发更推荐直接跑宿主机二进制：
#   make runner
ARG GO_IMAGE=golang:1.22-alpine
ARG RUNTIME_IMAGE=alpine:3.20

FROM ${GO_IMAGE} AS build
WORKDIR /src
# 单条 COPY + 只 COPY 必需文件：避免多 COPY 并发读同一 context（OrbStack buildkit
# 有 checksum 竞态），也让层缓存更稳。
COPY go.mod main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags '-s -w' -o /out/runner .

FROM ${RUNTIME_IMAGE}
# docker-cli: 构建/推送；kubectl/helm: k8s 部署；openssh-client: ssh/scp 部署；
# git: 少数构建脚本会用；ca-certificates: 私有仓库 HTTPS。
RUN apk add --no-cache docker-cli kubectl helm openssh-client git ca-certificates \
 && mkdir -p /logs

COPY --from=build /out/runner /usr/local/bin/cicd-runner

ENV RUNNER_BIND=0.0.0.0:8899 \
    RUNNER_LOG_DIR=/logs \
    RUNNER_MAX_JOBS=4

EXPOSE 8899
# /healthz 也要求 X-Runner-Token（runner 对所有端点一视同仁），
# 所以健康检查从环境里读同一个令牌，不再额外开白名单口子。
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD sh -c 'wget -qO- --header="X-Runner-Token: $RUNNER_AUTH" "http://127.0.0.1:8899/healthz" >/dev/null' || exit 1

# 以 root 运行才能读 /var/run/docker.sock（宿主 docker 组）；容器本身不对外暴露。
CMD ["/usr/local/bin/cicd-runner"]
