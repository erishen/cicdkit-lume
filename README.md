# cicdkit-lume

**用 Lume 控制面 + 薄 runner 取代 [cicdkit](https://github.com/erishen/cicdkit)**。

原来的 cicdkit 是一个 1.3 万行 Go 服务（Web + 调度 + 构建/部署执行 + LLM + 知识库全在一个
进程、一个 232MB 镜像里）。这里把它拆成两半：

| 组件 | 职责 | 形态 |
| --- | --- | --- |
| **控制面**（本仓 `.lume` 代码） | 静态站 + SPA 回退 + 全部 JSON API、项目/运行/部署状态（SQLite）、发布审批闸门、LLM 诊断与知识库、探针、**把项目配置翻译成 argv 执行计划** | Lume 单进程（DSL，无后台线程） |
| **runner**（`runner/`） | 只按收到的 argv 逐条执行 `docker` / `kubectl` / `helm` / `ssh` / `scp`，把输出按字节流写进日志文件 | Go 单二进制，内网 HTTP，无业务逻辑 |

cicdkit 进程和镜像可以整个下线：控制面不再 proxy 任何上游，`/api/*` 全部本地实现。

## 为什么拆

`TODO.md` P14 已定：lume DSL 永久不合并 `spawn` / `proc`——DSL 里拿不到子进程。所以
「谁来真正跑 `docker build`」只能在 DSL 之外解决。三个候选形态（A 在 DSL 内硬塞进程、
B 控制面 + 薄执行器、C 把 cicdkit 降级成 runner）里选了 **B**：控制面保留全部决策，
执行器只做无状态执行和日志落盘，职责边界清楚，两边都能单独替换。

## 技术栈

| 组件 | 角色 |
| --- | --- |
| **lume**（framework 二进制） | HTTP 服务：`server{}` + 路由 + SPA 回退 + 大静态文件流式发送 |
| **lume-core** | 语言核心 + `lib/*.lume`；`src/guard.lume` import `approval.lume` 做发布闸门 |
| **SQLite**（lume 内建） | 项目 / 运行 / 部署 / 知识库 / 配置，单文件 `store.db` |
| **React 18 + TypeScript** | 控制台 SPA，esbuild 打包成 `www/app.js`，由 docroot 直接伺服 |
| **Go**（`runner/`） | 执行器，`CGO_ENABLED=0` 静态编译，单二进制 |

## 目录

```
cicdkit_lume.lume        Lume 入口：server{} + Lume 路由（原生，不再 proxy）
src/store.lume           SQLite 存储：项目/运行/部署/KB/配置 + 旧 store.json 一次性导入
src/redact.lume          脱敏：配置读取回填掩码 + 日志读出侧 mask_log()
src/validate.lume        项目配置校验（与 cicdkit 的校验规则对齐）
src/exec.lume            argv 计划生成器（build / push / deploy / ssh）+ runner 客户端
src/jobs.lume            运行生命周期：启动、同步、取消、日志尾、部署落账
src/app_api.lume         全部 API 实现（项目 CRUD/动作/运行/部署/KB/LLM/诊断/目录）
src/guard.lume           发布与写操作的审批闸门
src/web/                 React 控制台（api.ts + app.tsx）
runner/                  Go 执行器（main.go + go.mod + Dockerfile）
www/                     docroot：index.html + app.css + 构建产物 app.js
scripts/                 自测与运维脚本（见下）
vendor/lume-core/lib/    lume-core 共享模块（入库，带版本戳）
```

## 快速开始

前置：Node 18+、Docker CLI、本机 `lume` 二进制（`make vendor` 会准备）。

```bash
make vendor     # 同步 lume 二进制 + lume-core/lib
make runner     # 另开一个终端：编并启动 runner（127.0.0.1:8899）
make dev        # 打包前端 + 起控制面 → http://127.0.0.1:8096
```

runner 推荐跑在**宿主机**（`make runner`）：`docker.sock`、`kubectl`、`~/.ssh` 都是现成的，
也不存在「容器内路径 ≠ 宿主路径」导致 `docker build` 找不到 context 的坑。

单独构建 / 校验：

```bash
make check      # lume --check 遍历入口 + 所有模块
make ui         # esbuild 打包 → www/app.js
make test       # 自测：store 77 + exec 73 + generate 26 + a2a 45 + 闸门 108 + runner go test（临时实例，不碰真实数据）
make plan       # 对着真实项目把 argv 计划干跑一遍（迁移前先看它要跑什么）
make smoke      # 对运行中的服务做只读冒烟
```

## 迁移旧数据

控制面启动时 `store.init()` 后调 `store.import_legacy()`：**只在库里还没有项目时**，
从 `$LUME_DATA/store.json` + `$LUME_DATA/kb.json`（或 `CICD_LEGACY_STORE` 指定的路径）
一次性导入。实测用真实历史数据（3.3MB）导入：

```
legacy import: {"imported":true,"projects":6,"runs":200,"deployments":169,"kb":0}
```

迁移后 cicdkit 的 `data/` 目录只剩存档价值。真实项目里两个必须显式处理的点：

- `lume-crm` 顶层 deploy 是 kubectl 系，原来依赖 cicdkit 容器里的 `CICD_DEFAULT_KUBECONFIG`。
  控制面**强制要求 kubeconfig 可解析**（顺序：`deploy.kubeconfig` → `KUBECONFIG` →
  `CICD_DEFAULT_KUBECONFIG`），三者皆空会明确报「缺少 kubeconfig」而不是跑到一半失败。
- SSH 私钥路径来自旧配置（`/app/data/ssh_*_key`），迁到新部署形态时要改成实际挂载路径。

## 环境变量

### 控制面

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LUME_DATA` | `./.data` | 数据目录：`store.db` + `logs/` + `logs-archive/`（归档的运行日志） |
| `RUNNER_BASE` | `http://127.0.0.1:8899` | runner 地址 |
| `RUNNER_AUTH` | 空 | runner 令牌，compose 里是**必填**（`make docker` 自动生成 `.data/runner.token`）；**不能**叫 `RUNNER_TOKEN`（Lume `env()` 屏蔽含 TOKEN 的名字） |
| `RUNNER_AUTH_FILE` | 空 | 从文件读令牌，优先于 `RUNNER_AUTH` |
| `CICD_WORK_DIR` | `$PWD` | 运行的工作目录（也是 `build.context` 的基准）。runner 只接受绝对路径，没配时回落到进程的 `$PWD` |
| `CICD_FS_ROOTS` | 空 | 目录浏览允许根（冒号分隔），越界 403 |
| `CICD_DEFAULT_KUBECONFIG` | 空 | kubectl/helm 部署的兜底 kubeconfig |
| `CICD_SSH_USER/PORT/KEY_PATH/CONTAINER/CONTAINER_PORT/PROBE_PORT/RUN_ARGS/COMMAND` | 空 | 部署字段的兜底值 |
| `CICD_DEPLOY_APPROVAL` | `off` | `off` / `approve`（需 `human_admin`）/ `execute`（需 `agent_operator`） |
| `CICD_LEGACY_STORE` | 空 | 导入时改用这个 store.json |
| `CICD_RUN_KEEP` | `300` | 运行历史保留条数；超出的**归档**（不删除），可用 `make restore ID=...` 恢复 |
| `CICD_ARCHIVE_KEEP` | `1000` | 归档保留条数；超出的最老归档连日志一起清掉（每次归档后裁剪） |
| `CICD_ROLE_MAP` | 空 | `human_admin=口令;agent_operator=口令`：设置后角色只能由 `?pass=` 反查，`?role=` 自报作废 |
| `CICD_HOOK_KEY` | 空 | webhook 共享密钥；为空时 `POST /api/webhook/:id` 一律 503（默认关闭） |
| `CICDKIT_PEER_SHARED` | 空 | peer 面共享密钥（与上游 `CICDKIT_PEER_*` 同一套命名，可与旧节点互通）。为空且没配 ROOT 时整面 fail-closed 关闭 |
| `CICDKIT_PEER_ROOT` | 空 | 派生密钥的根：`peer_key(node)=HMAC-SHA256(ROOT,"peer:"+node)`，**优先于** SHARED |
| `CICDKIT_PEER_REGISTRY` | `<LUME_DATA>/peers-identity.json` | 允许的节点清单 `{"peers":[...]}`；文件缺失时回落到 `CICDKIT_PEER_PEERS` |
| `CICDKIT_PEER_PEERS` | 空 | 逗号分隔的节点名，作为注册表兜底（首次部署还没生成注册表时用） |
| `CICDKIT_PEER_NAME` | `cicdkit-lume` | 本节点名（出站签名用；入站时对方按这个名字查密钥） |
| `CICDKIT_PEER_SKEW` | `120` | 时间窗（秒），超出即 401 |
| `CICDKIT_A2A_PUBLIC_URL` | 空 | Agent Card 里对外公告的地址。**Lume 读不到请求头（也就读不到 Host）**，不配就只能拼 `http://127.0.0.1:<LUME_PORT>` |
| `LUME_BIND` / `LUME_PORT` | `127.0.0.1` / `8096` | 监听地址 |
| `HTPASSWD_FILE` | 空 | 启用 Basic Auth（对外暴露时必须）。注意它会同时保护 `/metrics/cicdkit`：启用后 Prometheus 必须配 `basic_auth`，否则抓取 401 |

### runner

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `RUNNER_BIND` | `127.0.0.1:8899` | 监听地址（容器里是 `0.0.0.0:8899`） |
| `RUNNER_LOG_DIR` | `./logs` | 日志目录，**必须与控制面的 `LUME_DATA/logs` 同一个目录** |
| `RUNNER_AUTH` / `RUNNER_AUTH_FILE` | 空 | 令牌，所有端点（含 `/healthz`）都要带 `X-Runner-Token` |
| `RUNNER_ALLOW` | `docker,kubectl,ssh,helm,git,scp,sudo` | argv[0] 白名单 |
| `RUNNER_MAX_JOBS` | `4` | 并发 job 上限 |
| `RUNNER_LOG_MAX_BYTES` | `16769024`（16 MiB − 8 KiB） | 单个 job 日志文件的封顶大小。到顶后停写并追加一行 `[log capped at ...]`，**不会**让构建失败 |

## 执行模型

1. 前端触发动作 → 控制面按项目配置生成 argv 计划（`src/exec.lume`）。
2. 计划整体 `POST` 给 runner（`{name, steps[], timeout_s, work_dir}`），runner 逐条执行，
   每条 step 的 stdout/stderr 追加进 `<RUNNER_LOG_DIR>/<job_id>.log`。
3. 前端每 1.5s 轮询 `GET /api/runs/:id/log?from=<字节偏移>`，增量拿日志；同一请求顺手把
   runner 的 `GET /jobs/:id` 状态同步回来（done→success、failed→failed、canceled→canceled）。
4. 只有成功后控制面才写 `deployments` 和项目的 `last_deploy`。

**没有后台线程**：Lume DSL 跑不了常驻调度器，所以「同步」由前端轮询顺手驱动。代价是
没人看页面时状态不会自己推进；换来的是控制面完全无状态机、重启只读库。runner 重启丢
job 时，控制面把该运行标成 `interrupted`，不会误判成 failed。

### 与 cicdkit 执行面的有意差异

- `local-k3s` 导入改成 `docker save -o <tar>` → `k3s ctr images import <tar>` → `rm -f <tar>`：
  runner 不解释 shell，不吃管道。`-` 参数相应换成 tar 路径。
- helm `--set` 顺序：`helm_values` 先、镜像键后（原实现相反，镜像键会被自定义值覆盖）。
- 放弃 `tag_strategy=git-sha`，统一时间戳 tag（runner 侧不引入 git 参数注入面）。
- ssh 传输是 `save → scp → rm → ssh + load` 四步，替代原来的流式管道 + 远端磁盘预检。

## API

全部同源，浏览器无需 Token：

| 端点 | 说明 |
| --- | --- |
| `GET /api/version` | 控制面版本 |
| `GET /metrics/cicdkit`（别名 `/api/metrics`） | Prometheus 文本指标；`/metrics` 被 lume 框架占用，抓取路径要指这里 |
| `GET /api/health` | 本进程健康 + `runner_ok`（runner 掉线不拖垮容器探针） |
| `GET /api/meta` | 审批闸门策略（模式、审批链、角色表） |
| `GET /api/overview` | 首屏聚合：计数、运行中/失败数、最近记录、`connected` |
| `GET /api/projects` | 项目列表（`?q=&limit=&offset=`） |
| `POST /api/projects` | 新建项目（需 `?role=human_admin`） |
| `POST /api/projects/scan` | 扫描候选目录（有 Dockerfile 或 deploy/k8s/chart/） |
| `GET/PUT /api/projects/:id` | 详情 / 保存（PUT 需 `?role=human_admin`，掩码字段不回写） |
| `DELETE /api/projects/:id` | 删除项目（需 `?role=human_admin`） |
| `GET/POST /api/projects/:id/generate` | 补 `Dockerfile` / k8s 清单；GET = 只出方案，POST 带 `?apply=1` 才落盘（需 `?role=human_admin`） |
| `GET /api/projects/:id/visits` | 线上访客统计：域名取自 target `note` 的「公网域名 …」、PIN 取自 `*_VISIT_PIN=`；未配置 → `configured:false`，站点挂了 → `online:false` |
| `POST /api/projects/:id/:action` | `build` / `pipeline` / `validate` / `probe`（`validate` / `probe` 也支持 GET） |
| `POST /api/webhook/:id` | 外部 CI 触发流水线；`?secret=` 对 `CICD_HOOK_KEY`，不受角色闸门 |
| `GET /api/projects/:id/deploy-versions` | 发布版本列表（同目标去重、时间倒序），给回滚下拉用 |
| `POST /api/projects/:id/rollback` | 回滚：不传 body = 上一版；带 `image_ref` = 回滚到指定历史版本（只认该项目发布过的镜像）。受发布闸门保护，`trigger=rollback` |
| `POST /api/projects/:id/deploy` | **发布**，受审批闸门保护 |
| `GET /api/runs`、`GET /api/runs/:id` | 运行列表 / 详情 |
| `GET /api/runs/:id/log` | 增量日志尾（`?from=` 字节偏移） |
| `POST /api/runs/:id/cancel` | 取消（转给 runner） |
| `GET /api/runs/archive` | 归档列表（被 `CICD_RUN_KEEP` 收走的运行，含日志大小） |
| `POST /api/runs/:id/restore` | 从归档恢复运行 + 日志（需 `?role=human_admin`） |
| `DELETE /api/runs` | 清空运行记录（需 `?role=human_admin`） |
| `GET /api/deployments`、`DELETE /api/deployments` | 部署历史 / 清空 |
| `GET /api/deployments/:id` | 单条部署记录（含 `run_id`、`probe` 结果） |
| `POST /api/deployments/:id/diagnose` | 对该部署对应的运行做 AI 诊断（运行已裁掉 → 404） |
| `GET /api/config/llm`、`PUT`、`POST /api/config/llm/test` | LLM 配置（掩码）/ 保存 / 连通性测试 |
| `POST /api/runs/:id/diagnose`、`POST /api/runs/:id/diagnosis/adopt` | AI 诊断（需任意合法角色，全局每分钟最多 3 次；同 run 命中缓存不计费）/ 采纳入知识库 |
| `GET /api/kb`、`POST /api/kb`、`DELETE /api/kb/:id` | 知识库 |
| `GET /api/fs/roots`、`GET /api/fs/list` | 目录浏览（控制面先做前缀校验，再由 runner `EvalSymlinks` 后比根，软链接逃逸会被隐藏） |
| `GET /api/config/ssh-defaults` | SSH 兜底配置（前端表单预填） |
| `GET /.well-known/agent-card.json` | A2A Agent Card（公开发现，列 5 个只读能力） |
| `POST /a2a` | A2A JSON-RPC：`message/send`、`tasks/get`、`tasks/cancel` |
| `GET /peer/health`、`GET /peer/tools` | peer 签名面（HMAC，`?node=&ts=&nonce=&sig=`） |
| `POST /peer/invoke`、`POST /peer/relay` | 带参调用只读能力；relay 已退役（410） |

`?role=` 只在本层做闸门判定，是**流程门禁**而不是身份认证——真正的身份边界交给
`HTPASSWD_FILE` 或反向代理。想让角色不能随口报，就设 `CICD_ROLE_MAP`
（`human_admin=hp1;agent_operator=op1`）：之后请求必须带 `?pass=<口令>`，角色由口令
反查，`?role=` 单独出现不再作数；声明角色与口令不符也拒（拿操作员口令冒充终审会被挡）。
口令走 query 是因为 Lume 的请求对象读不到请求头；前端顶栏有「口令」输入框，存在 localStorage。

## 与上游 cicdkit 的功能对照

逐条对照表（含有意差异与原因）在 [`docs/PARITY.md`](docs/PARITY.md)。最需要记住的三条：

- 指标在 `/metrics/cicdkit`：`/metrics` 被 lume 的 agent-httpd 硬编码占用，脚本层改不了。
- 直方图只统计改版后跑过的运行：runner 新加了 `started_ts`/`ended_ts`，旧记录没有。
- 身份边界是 `HTPASSWD_FILE` + 角色口令：Lume 读不到请求头，实现不了上游的 `X-API-Token`。
- 并行期监控：`cicdkit-lume` 已加入 tsm-hub 的 `cicd-monitor` 网络，Prometheus 里有独立 job `cicdkit-lume` 抓 `/metrics/cicdkit`；正式切换步骤见 `docs/PARITY.md` 的「监控接入」。

## 发布审批闸门

`src/guard.lume` import `vendor/lume-core/lib/approval.lume`，用**职责分离**模型：

| 角色 | 动作 |
| --- | --- |
| `agent_operator` | `execute`（构建/流水线） |
| `agent_reviewer` / `agent_reviewer_second` | 一审 / 二审 |
| `human_admin` | `approve`（发布、改配置、清数据、改项目） |

## 脱敏

两条链路都必须挡住明文密钥：

- **写入侧**：`PUT` 项目/LLM 时前端回传 `********` 表示「保持不变」，`merge_secrets`
  保证库里存的还是旧值。
- **读出侧**：`GET` 永远不回传明文。运行日志和诊断提示词都过 `mask_log()`
  （`SECRET_RE` / `KEY_RE` / `BEARER_RE`），因为构建参数里本来就有
  `--build-arg LLM_API_KEY=...`、`-e *_VISIT_PIN=...` 这类真值。

### 切换前体检与路径重映射

迁移过来的项目里有一批「cicdkit 容器视角」的绝对路径，宿主机 runner 跑之前必须换成本机
真实路径，否则第一步就失败：

```bash
make preflight     # 体检：build.context / Dockerfile / kubeconfig / ssh key 是否真实存在
make remap         # 干跑：按 PATH_MAP 打印「旧路径 → 新路径（存在/不存在）」
make remap-apply   # 先备份 store.db 再落库
```

`PATH_MAP` 是「旧前缀:新前缀」的逗号分隔列表，例如本机实际的迁移：

```bash
PATH_MAP="/app/data:$PWD/../cicdkit/data-docker,/workspace:$HOME/Workspace/CNB/individular-invest/work" \
  LUME_DATA=./.data APPLY=1 ./vendor/lume/bin/lume scripts/remap_paths.lume
```

- 只按前缀替换，不看字段名，所以 `helm_values`、`run_args` 里出现的路径也会一起修。
- 目录存在性判定走父目录条目比对（`read_file(目录)` 给 null、`files(不存在的目录)` 给 `[]`，
  两个内建都不能直接当判据）。
- kubectl/helm/local-k3s 的 kubeconfig 为空时，用 `CICD_DEFAULT_KUBECONFIG` 兜底即可
  （preflight 会读这个 env）；不需要把私钥/kubeconfig 路径写死进项目。

### 清洗历史明文密钥

真实历史数据里 `build.build_args`（map 或被拼成 `--build-arg K=V`）与 `ssh_run_args`
存着 LLM Key 和 `*_VISIT_PIN`。读出口已经挡住，但库里仍是明文，任何能读 `store.db`
或其备份的人都拿得到。两步处理：

```bash
make sanitize          # 干跑：只列「哪个项目的哪个字段命中」，不打印明文
make sanitize-apply    # 先备份 store.db 再写库
```

- 判定逻辑在 `redact.mask_values()`（store_test 里有断言）：字符串形态走 `mask_log()`，
  map 形态（`build_args: {LLM_API_KEY: "sk-..."}`）整值换成 `********`，不留 `sk-********` 残形。
- 历史运行/部署的 json 里存着当初执行过的命令行，也会按字符串级脱敏（报告里单列 `history:`）。
- 幂等：清洗完再跑一次全部 `clean`。
- **是有损操作**：这些参数会变成掩码 `********`，依赖它们注入密钥的构建会失效。
  修法见下一节：`make migrate-args-apply` 把掩码改成 `secret:<名字>` 引用，值放
  `.data/secrets/`，构建照旧、日志里不再出现密钥。

### 构建参数里的密钥（`secret:<名字>`）

清洗把 `build_args` 里的密钥换成了 `********`，值没了构建就跑不起来。现在改成**引用**：

```bash
make migrate-args        # 干跑：列出 ******** → secret:<名字> 的映射
make migrate-args-apply  # 落库（先备份 store.db）
make secret NAME=lume_crm_llm_api_key VALUE=sk-...   # 真实值只写进 .data/secrets/<名字>（0600）
```

- 引用写法：`build_args` 的某个值写成 `secret:<名字>`，对应 `<LUME_DATA>/secrets/<名字>`（一行）。
- 解析在 `src/secrets.lume`，翻译发生在 `exec.build_steps`：命令行只留 `--build-arg LLM_API_KEY`（不带 `=值`），值进 step 的 `env`，docker 会从进程环境读——所以**argv、日志、`ps` 输出里都没有密钥**（runner 只打印 argv，不打印 env）。
- 为什么不用控制面环境变量：Lume 的 `env()` 把名字里含 `API_KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL` 的变量屏蔽成 `null`，而构建参数恰好最爱叫 `*_API_KEY`，走环境变量根本读不到。
- 文件缺失时**不降级成空值**，直接拒绝构建并指出该建哪个文件：`构建参数 LLM_API_KEY：缺少密钥文件 ./.data/secrets/lume_crm_llm_api_key`。
- 实测（真容器对）：Dockerfile 里 `ARG LLM_API_KEY` + `RUN test -n "$LLM_API_KEY"` 能拿到值、
  构建成功，而整份日志里搜不到密钥值，命令行只留 `--build-arg LLM_API_KEY`。
- 名字规则 `<项目名净化>_<参数名小写>`，只允许 `[A-Za-z0-9._-]`（它会拼进路径，`/` 与 `..` 一律拒）。
- 文件 `0600` 是宿主机直跑（`make dev` / `make runner`）的默认。走 compose 时控制面是
  uid 10001，读不了宿主机 0600 的文件，会报「密钥文件不可读（权限或容器 uid 不匹配）」——
  此时 `chmod 0644 .data/secrets/*` 再 `chmod 0755 .data/secrets`，或改成用容器自己的卷存密钥。

## A2A 与 peer 面（取代 `internal/a2a`）

两个面并存，与上游 cicdkit 的 `internal/a2a` 同形，能力全部**只读**：
项目总览、最近运行、最近部署、知识库摘要、能力自述。写入原语（触发流水线、删项目、
SSH、registry 操作）一律不进这两面——发布只能走人工审批闸门。

- **标准面**：`GET /.well-known/agent-card.json` 公开发现；`POST /a2a` 走 JSON-RPC
  （`message/send` / `tasks/get` / `tasks/cancel`）。任务落 SQLite（`a2a_tasks` 表），
  状态机沿用规范取值（`completed` / `rejected` / `input-required` …）；续跑只允许
  对 `input-required` 的任务补参数，终结态给 `-32004`，处理中给 `-32005`。
  Card 里的 url 来自 `CICDKIT_A2A_PUBLIC_URL`（读不到 Host 头，见环境变量表）。
- **peer 面**：`GET /peer/health` + `GET /peer/tools` + `POST /peer/invoke`
  （`POST /peer/relay` 保留但回 410，上游同样退役）。签名协议与
  `internal/a2a/peer.go` 字节级一致，可直接和 lume-a2a / tsm-hub 互通：

  ```
  sig   = HMAC-SHA256(KEY, node \n ts \n nonce \n scope)
  GET   scope = "GET "  + path_only
  POST  scope = "POST " + path_only + "\n" + body
  derived: KEY = HMAC-SHA256(CICDKIT_PEER_ROOT, "peer:" + node)
  ```

  入站一律走 query（`?node=&ts=&nonce=&sig=`），因为 Lume 的 route handler 读不到
  请求头。时间窗默认 ±120s，签名常量时间比较。**derived 模式不再回退共享密钥**：
  配了 ROOT 就只认派生密钥（否则拿共享密钥签一个能过的串就能绕过整套信任）。

  未配凭据时整面 fail-closed 关闭（返回 200 + `unauthorized:true` + 原因，与上游一致）。

与上游的一处有意差异：`GET /a2a` 上游是 302 到 `/`，Lume 的路由信封发不出 `Location`
头，与其给一个没有 Location 的 302，不如明确回 **405** 并说明「JSON-RPC 走 POST」。

## 外部 CI 触发（webhook）

给 GitLab/Jenkins/CNB 这类外部 CI 留的入口：它们没有飞书身份、也拿不到角色，所以不走角色闸门，靠共享密钥自证。

```bash
export CICD_HOOK_KEY=$(openssl rand -hex 24)   # 不设就是不启用，接口返回 503
curl -X POST "http://127.0.0.1:8096/api/webhook/lume-crm?secret=$CICD_HOOK_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"tag":"v1.2.3","method":"ssh","target":"阿里云"}'
```

- 只收 `POST`；`id` 缺失 400、项目不存在 404。
- 密钥只从 query `?secret=` 取（Lume 的请求对象不暴露请求头，`X-Webhook-Secret` 这条上游兼容没做）。
- body 全部可选：`tag`（覆盖自动时间戳 tag，只允许 `[A-Za-z0-9][A-Za-z0-9._-]*`，最长 128，否则 400）、`method`（受同一套白名单约束，非法 400）、`target`（不存在 400）。
- 成功返回 `202` 和 `run_id` —— 只是**受理**，进度照样去 `/api/runs/:id` 看。
- 触发的是 `pipeline`（构建 + 部署），`trigger` 记为 `webhook`，方便在运行列表里区分人点还是机器点。
- 自测：`scripts/test_gate.sh` 覆盖 503 / 401 / 404 / 400 四条拒绝路径（`CICD_HOOK_KEY=testkey` 起临时实例）。

**建议**：对外暴露时把 webhook 单独走内网或加 `HTPASSWD_FILE`；密钥一旦泄漏，等于把「随时触发发布」的能力给了对方。发布本身仍受 `CICD_DEPLOY_APPROVAL` 约束吗？——**不受**：webhook 走 `jobs.start(..., "pipeline")` 与人工点「流水线」同一条路径，闸门只管 `/deploy`。需要更严时把 `method` 不传、只让它构建。

## 脚手架生成

`/api/projects/:id/generate` 补两样东西：`Dockerfile`（项目里没有才生成）和 k8s 清单（部署方式是 `kubectl-apply` / `local-k3s` 且没有 `manifest_path` 时才生成）。

- 语言靠标记文件识别：`go.mod`→go、`package.json`→node、`requirements.txt`/`pyproject.toml`→python、`pom.xml`→java-maven、`build.gradle`→java-gradle、`Cargo.toml`→rust；都认不出就明确报错，不猜。
- 默认只预览：返回 `dockerfile` / `manifest` 两段 `{path, content}` 和 `config_updates`，一个字都不写。
- `?apply=1` 才落盘，并回写 `build.dockerfile`、`deploy.manifest_path`，顺带补 `deploy.container` 和 `build.image_repo`（空着才补）。
- **已有文件永不覆盖**；所有写入都限制在该项目的 `build.context` 内（`..` 逃逸直接拒绝）。
- 二次调用返回 `needs_any: false`，幂等。

## 自测

```bash
make test     # store 39 + exec 61 + gate 24
```

- `scripts/store_test.lume`：建库/迁移/掩码合并/时间列/清理，含明文密钥清洗的两种形态。
- `scripts/exec_test.lume`：argv 计划的 61 个断言（含 ssh 四步、helm set 顺序、kubeconfig 缺失）。
- `scripts/test_gate.sh`：起临时实例（runner 指向死端口 `127.0.0.1:9`），验证闸门 403、
  本地存储 404、`overview connected:false`、`health runner_ok:false`、建删项目、静态站 200。

## Docker

```bash
make docker        # 控制面 + runner 双服务 → http://127.0.0.1:18107
make backup     # SQLite 在线备份到 .data/backups/store-<ts>.db，保留 BACKUP_KEEP（默认 14）份
make docker-logs
make docker-down
```

- 控制面端口 **18107**，只发布到 `127.0.0.1`；runner 仅 `expose 8899`，不出宿主机。
- `./.data` 挂成**可写**（SQLite + 日志），`./.data/logs` 同时挂给 runner——
  两者必须指向同一个卷，否则前端永远看到空日志（增量读按字节偏移）。
- 项目目录必须**以相同绝对路径**挂进两个容器，否则 docker daemon 解析 `build.context` 会失败。
  所以 compose 里的 `PROJECTS_ROOT`（宿主项目根，绝对路径）**必填**，`make docker` 会自动带上
  `PROJECTS_ROOT=$(WORK)`；直接 `docker compose up` 会明确报「required variable 缺失」而不是
  悄悄映射到 `/projects`。
- `LEGACY_DATA`（默认 `../cicdkit/data-docker`）按宿主原路径只读挂入：项目配置里的
  `ssh_key_path` / `kubeconfig` 存的就是那个绝对路径，映射到别的目录只会让 SSH 找不到私钥。
  `make docker` 同时把 `CICD_DEFAULT_KUBECONFIG` 指到 `<LEGACY_DATA>/kubeconfig-cicd`。
- `./.data/secrets/*`（`make secret` 写、0600）在 Docker Desktop 下对容器 uid 10001
  仍然可读（宿主 uid 被映射成容器用户），不需要为了容器放宽到 0644。
- lume 二进制从既有镜像取（`LUME_BIN_IMAGE`，默认 `lume-bin:0.14.2`）：
  lume 是静态 C 单二进制，release 包在本机网络下不可达。

## 已知限制与运维提醒

- **角色默认是自报的（`?role=`），不是身份认证**：不配 `CICD_ROLE_MAP` 时，`CICD_DEPLOY_APPROVAL` 挡住的
  只是「没自报角色的手滑调用」，挡不住知道 URL 的人。配了口令后角色由 `?pass=` 反查，但口令本身仍在
  query 里（会进访问日志），且比较是普通字符串相等——它是"防误操作"而不是"抗攻击"。对外暴露仍必须加
  `HTPASSWD_FILE` 或前置反代。
  另一个坑：`env()` 会把名字里含 `TOKEN`/`SECRET`/`PASSWORD` 的变量对脚本层脱敏成 `null`，所以这个变量
  只能叫 `CICD_ROLE_MAP`（叫 `CICD_ROLE_TOKENS` 会永远读不到值，看起来像"口令全没生效"）。
- **`patch_run` 是读-改-写，没有事务**（Lume 的 SQL 护栏不开放事务，也没有进程内互斥）。
  已做的是「阶段没变化就不写库」把触发次数压到最低；单人多标签页同时盯同一运行仍有极窄的覆盖窗口。
- **日志读取走 runner 区间接口**：`GET /jobs/:id/log?from=…&max=…` 每次最多回 256 KiB，控制面优先用它；runner 重启丢了 job 或老运行没有 `job_id` 时，才回落到共享日志目录按整个文件读。
- **日志超过 16 MiB 有双层兜底**：runner 把文件封顶在 `RUNNER_LOG_MAX_BYTES`（默认 16 MiB − 8 KiB）并追加一行封顶标记；
  控制面的 `read_file` 对超限文件是**抛错而非截断**，所以接口侧再用 `try()` 兜住——遇到老 runner 或人为塞进来的超大日志也返回 200，
  带 `truncated` / `log_note`，前端顶部提示，完整日志去看控制面的 `<LUME_DATA>/logs/<run_id>.log`。
- **`write_file` 也有 16 MiB 上限**：控制面侧无法用 DSL 自己生成超大文件（自测里的 17 MiB 日志样本由 Makefile 用 dd 预置）。
  runner 是 Go 写的，写日志不受这条限制，但控制面读回来时仍受 16 MiB 读取上限约束，所以才有上面的封顶。
- **归档按条数保留**：`runs_archive` + `logs-archive/` 受 `CICD_ARCHIVE_KEEP`（默认 1000）约束，
  每次归档后裁剪最老的；`CICD_RUN_KEEP` 管的是活跃运行，两者独立。
  超过 16 MiB 的日志归档不了，`log_archived=false` 且原文件保留在 `logs/` 里。
- **SQLite 不能建索引**：DDL 护栏只允许 `CREATE TABLE`，`CREATE INDEX` 被拒。当前 200 来条记录无所谓，
  记录量上百倍增长后列表查询会变慢，到那时得换存储层而不是硬扛。
- **runner 的任务表只在内存里**：重启即丢，控制面会把还在跑的运行标成 `interrupted`（不会再标成 running 干等）。
- **A2A 任务表不会自动清理**（和 `runs` 不同，它没有保留策略）：每次 `message/send` 都落一条。
  只读问答量大了要手动清，或将来接上 `CICDKIT_A2A_KEEP`。任务记录里只有能力名/参数/结果摘要，
  不含日志原文。
- **peer 面不加密**：签名保证不可伪造/篡改，但明文传输；不要经此通道传密码、密钥、证件号。
  防重放只是时间窗级别（同一 nonce 在窗口内重放仍会过）。

## 还没做 / 已知取舍

- A2A 六端点（`/.well-known/agent-card.json`、`/a2a`、`/peer/health|tools|invoke|relay`）
  未移植：它整套建立在 Go 侧的 peer 签名/白名单体系上（`CICDKIT_PEER_*`），Linux
  进程间互调的语义搬进 lume 意义不大。需要 agent 互调时另起一个 lume 侧 peer 面。
- `tag_strategy=git-sha` 已放弃，统一时间戳 tag（webhook 可用 body 的 `tag` 指定）。
- `X-Webhook-Secret` 头不支持，密钥只走 query。
- 生成器只补 Dockerfile 与 k8s 清单两类；nginx/静态站、compose 文件不生成。
- 清空运行不会删日志文件，只清库记录。
- `interrupted` 是新增的运行终态，旧 UI 不认它时按「失败」展示即可。

## 版本

`vendor/.vendor-stamp` 记录二进制版本与库来源。本地兄弟 checkout 存在时用它
（本次实测配对：lume `0.14.0` + lume-core 工作树 `de7ce92`）；单独 clone 时从 GitHub
release 拉 `LUME_VERSION` / `LUME_CORE_TAG`（默认 `v0.13.1`）。

- `vendor/lume-core/lib/*.lume` **入库**：`src/guard.lume` 按源码路径 import。
- `vendor/lume/bin/lume` **不入库**：平台相关、体积大，首次 clone 后跑一次 `make vendor`。
- `vendor/.vendor-stamp` **不入库**：由 vendor 脚本按本机来源生成。
