# cicdkit-lume

cicdkit 的 **Lume + React 控制台**：Lume 单进程同时做静态站、SPA 回退和同源 JSON BFF，
把 [cicdkit](https://github.com/erishen/cicdkit)（Go 标准库实现的 CI/CD 管理平台）的 REST API
包装成一个浏览器可直接用的控制台。

> 定位：cicdkit 的 Web 层重写。cicdkit 原版用 Go `embed` 托管 Vite 前端，并让浏览器直连
> `/api/*`（需要用户自己保管 API Token）。这里换成 **Lume 托管 + 服务端注入 Token**：
> 浏览器只与 Lume 同源通信，`CICD_AUTH` 永远不落到 `localStorage` 或页面源码里。

## 技术栈

| 组件 | 角色 |
| --- | --- |
| **lume**（framework 二进制） | HTTP 服务：`server{}` + 路由 + SPA 回退 + 出站 `http_*` 代理 |
| **lume-core** | 语言核心 + `lib/*.lume` 共享模块；`src/guard.lume` import `approval.lume` 做发布审批闸门 |
| **React 18 + TypeScript** | 控制台 SPA，esbuild 打包成 `www/app.js`，由 Lume 的 docroot 直接伺服 |

## 目录

```
cicdkit_lume.lume        Lume 入口：server{} + 全部路由
src/api.lume             上游 cicdkit 客户端 + 总览聚合（服务端持有 Token）
src/guard.lume           发布动作的审批闸门（lume-core/lib/approval.lume）
src/web/                 React 控制台（api.ts + app.tsx）
www/                     docroot：index.html + app.css + 构建产物 app.js
scripts/vendor_lume.sh   同步 lume 二进制与 lume-core/lib 到 vendor/
scripts/smoke.sh         只读 HTTP 冒烟
vendor/lume-core/lib/    lume-core 共享模块（入库，带版本戳）
```

## 快速开始

前置：`cicdkit` 已在本机运行（默认 `127.0.0.1:8080`），Node 18+。

```bash
# 1. 同步 lume 二进制 + lume-core/lib（优先用兄弟 checkout ../../lume）
make vendor

# 2. 启动（自动 npm install + esbuild 打包 + 前台起 Lume）
make dev
#    → http://127.0.0.1:8096

# 上游不在默认地址 / 开了 API Token：
CICD_BASE=http://127.0.0.1:8080 CICD_AUTH='<your-token>' make dev
# 或把 token 放进文件（不会出现在进程环境里，更适合生产）：
#   printf '%s' "<your-token>" > .data/upstream.token
#   CICD_AUTH_FILE=.data/upstream.token make dev
```

> ⚠️ 变量名是 `CICD_AUTH`，**不是** `CICD_TOKEN`：Lume 的 `env()` 会对名字里含
> `TOKEN` / `SECRET` / `API_KEY` / `PASSWORD` / `CREDENTIAL` 的变量返回 `null`
> （防止机密被脚本读走）。直接把 Token 命名成 `CICD_TOKEN` 在这里恒为 null。

单独构建 / 校验：

```bash
make check      # lume --check：语法 + 类型
make ui         # esbuild 打包 → www/app.js
make smoke      # 对运行中的服务做一次只读冒烟
make stop       # 停掉 8096 上的服务
```

## Docker

容器里不需要宿主 Node：`Dockerfile` 分两段，node 阶段把控制台打包成 `www/app.js`，
runtime 阶段只有 alpine + lume 静态二进制（uid 10001，非 root），一个进程负责静态文件、
SPA 回退和 `/api/*`。

```bash
make docker        # docker compose up -d --build → http://127.0.0.1:18107
make docker-logs   # 跟日志
docker compose down
```

- 端口 **18107**（容器内同端口，只发布到 `127.0.0.1`）。
- 默认接入**已存在的** `cicdkit_default` 网络，容器内用 `http://cicdkit:8080` 访问上游；
  上游不在这个网络里时用 `CICD_BASE=http://host.docker.internal:10081 make docker`
  之类显式指定（该地址需要能绕过回环绑定）。
- 上游 `API_TOKEN` 走挂载文件 `.data/upstream.token`（`CICD_AUTH_FILE`），不进镜像、
  不上命令行；文件缺失时按“上游未开鉴权”处理。
- lume 二进制从已有的 lume 镜像里取，因为 lume 是静态 C 单二进制、release 包在本机
  网络下不可达：`--build-arg LUME_BIN_IMAGE=<含 /usr/local/bin/lume 的镜像>` 可换成自编版本。

健康检查打 `/api/health`（只验证本进程在服务；上游掉线看返回体里的 `ok`/`error`）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CICD_BASE` | `http://127.0.0.1:8080` | cicdkit 上游地址（回环/私网，`http_*` 显式 `allow_private`） |
| `CICD_AUTH` | 空 | 上游 `X-API-Token`；只在 Lume 进程内使用（名字不能含 `TOKEN`，Lume 会屏蔽） |
| `CICD_AUTH_FILE` | 空 | 从文件读 token，优先于 `CICD_AUTH`；末尾换行会被裁掉 |
| `CICD_DEPLOY_APPROVAL` | `off` | 发布闸门：`off` / `approve`（需 `human_admin`）/ `execute`（需 `agent_operator`） |
| `LUME_BIND` / `LUME_PORT` | `127.0.0.1` / `8096` | 监听地址 |
| `HTPASSWD_FILE` | 空 | 设置后启用 Basic Auth（对外暴露时必须） |

## API

全部同源，浏览器无需 Token：

| 端点 | 说明 |
| --- | --- |
| `GET /api/health` | 本服务 + 上游健康检查（上游版本号） |
| `GET /api/meta` | 上游地址 + 审批闸门策略（模式、审批链、角色表） |
| `GET /api/overview` | 首屏聚合：项目/运行/部署计数、运行中/失败数、最近 8 条 |
| `GET /api/projects` | 项目列表（`?q=&limit=&offset=` 透传） |
| `GET /api/projects/:id` | 项目详情 |
| `PUT /api/projects/:id` | 保存项目配置（整份替换，需 `?role=human_admin`） |
| `GET /api/fs/roots` | 上游机器上可浏览的目录根（需 `?role=human_admin`） |
| `GET /api/fs/list` | 列出目录内容（`?dir=`，需 `?role=human_admin`） |
| `POST /api/projects/:id/deploy` | **发布**，受审批闸门保护 |
| `POST /api/projects/:id/:action` | `build` / `pipeline` / `validate` / `probe` 透传 |
| `GET /api/runs` | 运行列表（`?project_id=&limit=&offset=`） |
| `GET /api/runs/:id/log` | 增量日志尾（`?from=` 字节偏移，1.5s 轮询） |
| `POST /api/runs/:id/cancel` | 取消运行 |
| `GET /api/runs/:id` | 运行详情 |
| `GET /api/deployments` | 部署历史（`?project_id=&limit=&offset=`） |
| `GET /api/config/llm` | LLM 配置（掩码，只有 `api_key_set`） |
| `PUT /api/config/llm` | 保存 LLM 配置（需 `?role=human_admin`） |
| `POST /api/config/llm/test` | 测试 LLM 连通性（需 `?role=human_admin`） |
| `POST /api/runs/:id/diagnose` | AI 诊断一次失败运行 |
| `POST /api/runs/:id/diagnosis/adopt` | 采纳 / 不采纳（采纳写入知识库） |
| `GET /api/kb` | 知识库条目列表（`?q=` 按项目/阶段/报错/结论过滤） |
| `DELETE /api/kb/:id` | 删除一条知识库条目 |

上游不可达时透传端点统一返回 `502 { ok:false, error }`，前端显示可重试的错误条。

### 并发与超时

Lume（agent-httpd）的模型是「主事件循环 + 阻塞型 worker 池」：静态文件走主循环，
`/api/*` 这类同步出站调用各占一个 worker。这里显式 `workers = 8`（框架默认值）——
原来设 2 时，两个 AI 诊断（预算 180s）就能把整个 API 层堵死。

| 场景 | 预算 | 失败表现 |
| --- | --- | --- |
| `/api/health` | 2s（上游健康失败时跳过版本号） | `ok:false` + `error`，容器探针不超时误判 |
| `/api/overview` | 3 × 5s（项目/运行/部署串行） | 部分数据 + `connected:false` + `errors.*`，前端标「不可用」并显示原因 |
| 普通读写透传 | 30s | `502 { ok:false, error }` |
| AI 诊断 / LLM 测试 | 180s | 同上（上游模型调用本身 150s，网关不能先断） |

`?role=` 只在本层做闸门判定，**不再转发给上游**：上游 cicdkit 不读这个参数，转发过去
只会把角色串写进它的访问日志。其余查询参数（`?q=` `?limit=` `?from=`）原样透传。

## 发布审批闸门（lume-core）

`src/guard.lume` import `vendor/lume-core/lib/approval.lume`，用的是它的
**职责分离**模型而不是角色等级：

| 角色 | 动作 |
| --- | --- |
| `agent_operator` | `execute`（构建/流水线） |
| `agent_reviewer` / `agent_reviewer_second` | 一审 / 二审 |
| `human_admin` | `approve`（发布） |

- `CICD_DEPLOY_APPROVAL=off`（默认）：发布行为与 cicdkit 原版一致。
- `=approve`：发布要求 `?role=human_admin`；其他角色返回 `403` 并附审批链。
- `=execute`：发布要求 `?role=agent_operator`。

前端顶栏的「角色」选择器把角色放在 `?role=` 查询参数里（Lume 的 `req` 不暴露请求头）。
该参数只在 BFF 内用于闸门判定，转发上游前会被剔掉，不会出现在 cicdkit 的访问日志里。
这是**流程门禁**，不是身份认证——真正的身份边界交给 `HTPASSWD_FILE` 或反向代理。

## AI 故障诊断（可选 LLM）

失败运行在日志抽屉里多一个「**AI 诊断**」按钮：把失败阶段日志发给兼容 OpenAI
的 `/chat/completions`，返回中文根因 + 证据 + 修复步骤。能力本身在上游
cicdkit（`internal/llm` + `internal/kb`），这个控制台只是把入口接回来：

- **配置不落在这里**：Base URL / API Key / Model / 系统提示词仍然写在上游
  `data/llm.json`（0600）。前端只做掩码编辑，`GET` 永不回传明文 Key；
  想用环境变量兜底就是上游的 `CICD_LLM_*`（那个容器里设）。
- **顶栏「LLM」按钮**打开设置面板，可以改配置、点「测试连接」（发一个最小请求验连通）。
  写配置 / 测试连接**强制要求** `?role=human_admin`（顶栏角色选「终审」）：
  这一层能改 BaseURL 并让服务端用已存密钥去请求它，不能让任意访客把密钥指向自己的地址。
- **成本与缓存**：上游命中知识库同类失败时直接复用结论，不调模型；非命中时调用一次并把
  结果缓存在运行记录上，重复点诊断不会重复计费。
- **脱敏**：日志外发前上游把 IPv4/IPv6、`user@host`、`/Users/ /home/ /root/` 路径替换为占位符。
- **知识库**：诊断结果可以「采纳」写入上游 `kb.json`，后续同类失败按相似度匹配复用（取前 3 条）；
  面板里会列出命中的历史同类诊断。顶栏「知识库」页只读列出全部条目（可按文本过滤、点行展开完整结论），
  并支持删除；新增仍然只能来自诊断的「采纳」，因为上游只有列表与 DELETE 两个接口。
- 未配置 LLM 时点诊断会返回上游的提示「LLM 未配置：请先在「设置」中填写…」，不会 500。

## 项目配置编辑（含服务器目录选择）

项目卡片上的「编辑」打开一个表单，覆盖名称 / 描述 / 仓库 / 分支 / 镜像仓库 / tag 策略 /
构建上下文 / Dockerfile / 是否推送镜像，保存走 `PUT /api/projects/:id`：

- **整份替换**：上游的 PUT 不是 patch。前端先 `GET` 到完整对象、只改表单里的字段再整份写回，
  否则 `targets` / `probe` 这些没在表单里的字段会被清空。
- **目录选择器**：`build.context` 决定 docker 从哪里取上下文，而浏览器拿不到服务器路径。
  「浏览目录」走 `GET /api/fs/roots` + `GET /api/fs/list`，在**上游机器**的允许根目录
  （`FS_ROOTS`）里点选；上游会解析 symlink 后二次校验，越界返回 403。
- **门禁**：保存与浏览都要求 `?role=human_admin`（与改 LLM 配置同级）。和其他闸门一样，
  这是流程门禁，真实身份边界仍是 `HTPASSWD_FILE` / 反向代理。

## 与 cicdkit 原版前端的差异

- 只做只读看板 + 构建/发布/取消 + AI 诊断；项目页可编辑**现有**项目的配置，
  仍不做「新建项目 / 扫描导入」（那需要完整的建项表单，还在 cicdkit 原版 UI）。
- 知识库页只做「列表 + 删除 + 结论展开」，不能手工新建/编辑（新增只能来自诊断的「采纳」）。
- 运行日志抽屉轮询 `/api/runs/:id/log?from=`，只取增量，不在浏览器保存完整日志。
- 没有任何前端状态写回磁盘；Lume 进程无状态，重启即回到上游真相。

## 版本

`vendor/.vendor-stamp` 记录二进制版本与库来源。本地兄弟 checkout 存在时用它
（本次实测配对：lume `0.14.0` + lume-core 工作树 `de7ce92`）；单独 clone 时从 GitHub
release 拉 `LUME_VERSION` / `LUME_CORE_TAG`（默认 `v0.13.1`，即当前已发布版本）。
Linux 用 `-static` 资产，macOS release 只有动态链接包（依赖 Homebrew openssl/sqlite3）。

### vendor 入库策略

- `vendor/lume-core/lib/*.lume` **入库**：`src/guard.lume` 按源码路径 `import`，
  clone 下来必须原样存在，否则 `lume --check` 直接失败。
- `vendor/lume/bin/lume` **不入库**：平台相关、体积大， macOS 上 vendor 脚本建的是
  指向兄弟 checkout 的软链（复制会破坏 codesign）。首次 clone 后跑一次 `make vendor`。
- `vendor/.vendor-stamp` **不入库**：由 vendor 脚本按本机来源生成（`local-checkout` /
  `release`），提交进来只会在别人机器上过时。版本配对以本节文字为准。
