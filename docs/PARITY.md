# 与上游 cicdkit 的功能对照

上游 `cicdkit` 现仍在并行运行（用户口径：先并行、不退役）。这份表是把两边的
HTTP 面逐条摊开对齐的结果：**能对齐的都对齐了**，剩下的是框架层面的硬差异或
有意取舍，每条都写了原因，别在排障时把它们当成 bug。

权威来源：上游 `internal/api/server.go`（路由注册表）、`handlers.go`（子资源分发）、
`metrics.go`；本仓 `cicdkit_lume.lume`（路由段）、`src/app_api.lume`。

## 端点对照

| 上游端点 | 本仓 | 状态 | 说明 |
| --- | --- | --- | --- |
| `GET /api/health` | 同路径 | 对齐 | 本仓多带 `runner_ok`/`store_ok`，是超集 |
| `GET /api/version` | 同路径 | 对齐 | 字段形状不同（本仓是静态 `native`），前端只用它显示版本 |
| `GET /metrics` | `GET /metrics/cicdkit`（别名 `/api/metrics`） | **有意差异** | 见下节「/metrics 被框架占用」 |
| `GET/POST /api/projects` | 同路径 | 对齐 | 同为 `?q=&limit=&offset=` |
| `POST /api/projects/scan` | 同路径 | 对齐 | 同受 human_admin 门禁 |
| `GET /api/fs/roots`、`GET /api/fs/list` | 同路径 | 对齐 | 本仓额外用 `CICD_FS_ROOTS` 做前缀校验 |
| `GET/PUT/DELETE /api/projects/:id` | 同路径 | 对齐 | PUT 掩码字段不回写 |
| `POST .../build`、`.../pipeline`、`.../deploy` | 同路径 | 对齐 | deploy 额外有审批闸门 |
| `GET/POST .../validate` | 同路径 | 对齐（载荷不同） | 上游回 `{ok, checks[]}`，本仓回 `{ok, error[], methods, target, deploy_ok}`；前端按本仓形状写 |
| `GET/POST .../probe` | 同路径 | 对齐 | 都直连 HTTP 探测，返回 status_code/headers/body/duration_ms |
| `GET .../visits` | 同路径 | **本轮补齐** | 域名取自 target `note` 的「公网域名 …」，PIN 取自 `*_VISIT_PIN=`；8s 超时；三种形态（未配置/断线/在线）与上游一致 |
| `GET .../generate` | 同路径 | **本轮补齐** | 上游 GET=出方案、POST=落盘；本仓之前只有 POST |
| `GET /api/runs`、`DELETE /api/runs` | 同路径 | 对齐 | 本仓 DELETE 需 human_admin |
| `GET /api/runs/:id`、`.../log`、`.../cancel` | 同路径 | 对齐 | 日志按 `?from=` 字节偏移增量读，与上游轮询方式一致 |
| `POST .../diagnose`、`.../diagnosis/adopt` | 同路径 | 对齐 | 诊断走本地 LLM 配置 + 知识库复用 |
| `GET /api/deployments`、`DELETE` | 同路径 | 对齐 | |
| `GET /api/deployments/:id` | 同路径 | **本轮补齐** | 返回部署记录本身（含 `run_id`、`probe`） |
| `POST /api/deployments/:id/diagnose` | 同路径 | **本轮补齐** | 转给该 `run_id` 的运行诊断；运行已被裁掉 → 404 而不是 500 |
| `GET/PUT /api/config/llm`、`POST .../test` | 同路径 | 对齐 | key 只进不出（掩码） |
| `GET /api/config/ssh-defaults` | 同路径 | 对齐 | |
| `GET /api/kb`、`POST /api/kb`、`DELETE /api/kb/:id` | 同路径 | 对齐 | |
| `POST /api/webhook/:id` | 同路径 | 对齐（鉴权载体不同） | 本仓只认 `?secret=`；上游还看 `X-Webhook-Secret` 头（Lume 读不到请求头） |
| `/.well-known/agent-card.json`、`POST /a2a`、`/peer/*` | 同路径 | 对齐 | 见下节 A2A 差异 |
| 本仓独有：`.../deploy-versions`、`.../rollback`、`/api/runs/archive`、`/api/runs/:id/restore`、`/api/meta`、`/api/overview` | — | 超集 | 回滚/归档是上游没有的能力（本次取代过程中补的） |

## 有意差异（框架层限制或取舍）

1. **`/metrics` 被框架占用。** lume 的 agent-httpd 在自定义路由之前就拦截
   `/metrics`，返回它自己的 `agenthttpd_*` 计数（`http_route.c` 里硬编码），脚本
   层改不了。控制面指标因此挂在 **`/metrics/cicdkit`**（并给 `/api/metrics` 别名）。
   Prometheus 的 scrape path 需要相应指过来；指标名、HELP 文案、标签枚举与上游
   完全一致（`cicdkit_active_runs`、`cicdkit_max_concurrent`、
   `cicdkit_runs_total{status=}`、`cicdkit_deploys_total`、
   `cicdkit_probe_total{result=}`、`cicdkit_build_seconds`/`cicdkit_deploy_seconds`
   直方图，桶边界同为 10/30/60/120/300/600/1800/3600/+Inf）。
   Content-Type 只有 `text/plain`（没有 `version=0.0.4` 参数），Prometheus 照样能抓。

2. **直方图数据来自新运行。** Lume 没有日期解析内建，ISO 字符串减不出秒数；
   runner 因此给每一步加了 `started_ts`/`ended_ts`（unix 整秒），控制面相减得
   时长。**只有改版之后跑过的运行才进直方图**，历史运行补不了（旧记录没有这些
   字段），所以刚切换时 `cicdkit_build_seconds_count` 会明显小于运行总数——这是
   预期，不是丢数据。

3. **身份边界换成 `HTPASSWD_FILE` + 角色口令。** 上游用 `X-API-Token` /
   `Authorization: Bearer` 做常量时间比较；Lume 的请求对象读不到请求头，所以
   本仓用 Basic Auth 做真身份、用 `CICD_ROLE_MAP` + `?pass=` 做角色绑定。
   `?role=` 单独出现只是流程门禁，不是认证。

4. **`GET /a2a` 回 405，不是 302。** 上游 302 到 `/`；Lume 的路由信封发不出
   `Location` 头，伪造一个「没有 Location 的 302」只会让客户端困惑，所以显式 405。

5. **`POST /peer/relay` 固定 410 Gone。** 上游也是退役语义，这里保留同样的状态码
   让旧调用方知道「这条路没了」，而不是 404。

6. **A2A 任务没有保留策略。** 上游一任务一文件，删就删了；本仓落 SQLite 且
   Lume 没有 `remove_file`/无事务，目前只增不减（`a2a_tasks` 表）。量级很小
   （只读能力的调用记录），但**长期跑会缓慢增长**，需要时再定 `CICDKIT_A2A_KEEP`。

7. **peer 面不加密。** 与上游一致：HMAC 只保证完整性和身份，不保证机密性；
   要跨公网就跑在 WireGuard / 反代 TLS 后面。

8. **`tag_strategy=git-sha` 未实现。** 早期就放弃了这个策略（构建参数走
   `build_args` + 时间戳 tag），上游该字段在本仓按未知值处理。

## A2A / peer 面

六端点、五种只读能力、任务状态机、签名串（`node\nts\nnonce\nscope`）、
shared/derived 两种凭据模式、`unknown peer` 拒绝、过期 `ts` 拒绝、body 篡改失效，
均与上游同形，gate 里有 20+ 条断言覆盖。差异只有上表第 4、5、6、7 条。

## 前端

- 部署页每行可点：直接打开那次运行的抽屉（日志 + AI 诊断），与上游
  「部署 → 诊断」的落点一致；`POST /api/deployments/:id/diagnose` 同时提供给
  自动化/脚本直接调用。
- 访客统计目前只有 API，没有面板：本仓没有「项目详情页」，项目列表页塞一列
  访客数会很吵。需要时再加独立详情页，接口已经就绪（三种返回形态都实现并实测）。

## 监控接入（与上游并行期）

lume 的控制面容器已挂到 tsm-hub Prometheus 的共享网络 `cicd-monitor`，
tsm-hub 里新增了一个并行 job：

```yaml
- job_name: cicdkit-lume
  metrics_path: /metrics/cicdkit
  targets: ["cicdkit-lume:18107"]
```

上游 job `cicdkit`（`cicdkit:8080/metrics`）保持不动，两边同时抓。Grafana 新增
面板 `cicdkit-lume CI/CD 监控（并行期）`（uid `cicdkit-lume`），所有查询都按
`job="cicdkit-lume"` 过滤，所以两套同名指标不会混在一起。

**正式切换时**：把 job `cicdkit` 的 target 改成 `cicdkit-lume:18107`、路径改成
`/metrics/cicdkit`，删掉并行 job，并把面板的 job 过滤改回去（或直接沿用
`cicdkit-lume` 面板）；告警 `CicdkitDown` 随之自动盯上 lume。

## LLM 诊断

上游 `llm.json` 的配置已搬到 lume 的 settings（同一个网关
`http://host.docker.internal:19070/v1`、同一把 key、同一段 system 提示词），
model 选 `chat`（网关把它映射到 `fastpath:codegen`，实测 4s 内返回；
`auto`/`deepseek-v4-flash` 在该网关排队常超 60s，做诊断不划算）。

注意这是 **tsm-hub 网关**（宿主 19070 → 容器 9070），不是 `tsmhub-lume`。
`tsmhub-lume`（18108）虽然也透传 `/v1/*`，但要求客户端用 `X-Api-Key` 传
`sk-tr-…`（Lume 脚本层读不到 `Authorization`），而 cicdkit-lume 的客户端发的是
`Authorization: Bearer`，直指过去只会得到 `missing_key`。等 tsm-hub 真正被
tsmhub-lume 取代时，要么前者支持 Bearer、要么 cicdkit-lume 换用 `X-Api-Key`，
再改 base_url 即可。

迁移时修掉一个 `chat_url` 的偏移 bug：原来用 `len(base)-4` 比 `"/v1"`，
比的是「含前一字符的 4 位尾巴」，永远不相等，导致 base 已带 `/v1` 时又拼成
`/v1/v1/chat/completions`（网关 404）。现在按字面量长度比较。
