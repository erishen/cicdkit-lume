# A2A 只读面使用示例

cicdkit-lume 暴露一个标准 A2A 发现面和 JSON-RPC 面，能力**全部只读**：查项目、查运行、查部署、查诊断知识库、列能力。触发流水线、删除项目、SSH、registry 操作都不在 A2A 里。

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/.well-known/agent-card.json` | Agent Card，公开发现，列 5 个 skill |
| `POST` | `/a2a` | JSON-RPC：`message/send` / `tasks/get` / `tasks/cancel` |
| `GET` | `/peer/health` | 节点健康（HMAC 签名） |
| `GET` | `/peer/tools` | 能力清单（HMAC 签名） |
| `POST` | `/peer/invoke` | 节点间只读调用（HMAC 签名） |

Basic Auth 开启后，所有 `/api/*`、`/a2a`、`/.well-known/*` 都要带凭据。脚本默认从仓库根 `.env` 读 `CICDKIT_BASIC_USER` / `CICDKIT_BASIC_PASS`，不给口令就只能访问无认证的 `make dev` 实例。

## 直接跑

```bash
make a2a-demo
# 或
./scripts/a2a_demo.sh demo
./scripts/a2a_demo.sh card
./scripts/a2a_demo.sh caps
./scripts/a2a_demo.sh send cicd.recent_runs '{"limit":3}'
./scripts/a2a_demo.sh get <task_id>
```

容器实例：

```bash
BASE_URL=http://127.0.0.1:18107 ./scripts/a2a_demo.sh demo
```

`make dev` 本地实例：

```bash
BASE_URL=http://127.0.0.1:8096 ./scripts/a2a_demo.sh demo
```

## 能力与参数

| capability | 返回 | 参数 |
| --- | --- | --- |
| `cicd.overview` | 项目数、项目名、最近运行状态计数、各项目最近一次运行 | `{}` |
| `cicd.recent_runs` | 最近构建记录（状态/阶段/耗时，不含原始日志） | `{"limit":5}`，上限 50 |
| `cicd.deployments` | 最近部署记录（镜像/集群/探测结果） | `{"limit":5}`，上限 50 |
| `cicd.knowledge` | 已采纳诊断摘要（只给 `diagnosis_len`，不给全文） | `{}` |
| `cicd.capabilities` | 能力自描述 | `{}` |

## 原始 curl

```bash
# 发现
curl -u "cicd:$PASS" http://127.0.0.1:18107/.well-known/agent-card.json

# 发任务
curl -u "cicd:$PASS" \
  -H 'content-type: application/json' \
  -d '{
    "jsonrpc":"2.0",
    "id":"demo-1",
    "method":"message/send",
    "params":{
      "message":{"role":"user","kind":"message","messageId":"m1",
                 "parts":[{"kind":"text","text":"看看项目总览"}]},
      "metadata":{"capability":"cicd.overview","args":{}}
    }
  }' \
  http://127.0.0.1:18107/a2a
```

任务同步执行，`message/send` 的响应里通常已经是终态，`result.id` 就是 `taskId`。之后可以：

```bash
curl -u "cicd:$PASS" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"get-1","method":"tasks/get","params":{"id":"<taskId>"}}' \
  http://127.0.0.1:18107/a2a
```

## 状态与错误

- 状态：`submitted` / `working` / `input-required` / `completed` / `failed` / `canceled` / `rejected`。
- 没带 `metadata.capability`：任务进入 `input-required`，返回可用能力列表；只有这个状态能补参数续跑。
- 未知能力：任务直接 `rejected`，不产出 `artifacts`。
- 错误码：任务不存在 `-32001`，终态不可取消 `-32002`，终态不可恢复 `-32004`，处理中不可补参 `-32005`，方法不存在 `-32601`，JSON 解析失败 `-32700`。
- 任务落 SQLite `a2a_tasks` 表，`id` 生成时会查库避免同秒覆盖。

## peer 面

`peer` 面用于节点间互调，签名协议与上游 `internal/a2a/peer.go` 一致：

```
sig  = HMAC-SHA256(KEY, node \n ts \n nonce \n scope)
GET  scope = "GET "  + path
POST scope = "POST " + path + "\n" + body
KEY  = CICDKIT_PEER_SHARED，或 HMAC-SHA256(CICDKIT_PEER_ROOT, "peer:" + node)
```

参数走 query（`?node=&ts=&nonce=&sig=`），因为 Lume 路由读不到请求头。未配 `CICDKIT_PEER_SHARED` / `CICDKIT_PEER_ROOT` 时整面 fail-closed，返回 `unauthorized:true`。

## 边界

- 不提供写入原语，发布仍只能走控制台 + `CICD_DEPLOY_APPROVAL` 审批闸门。
- 知识库只回摘要长度，不回诊断全文，避免 IP/路径/密钥痕迹外泄。
- Agent Card 的 `url` 来自 `CICDKIT_A2A_PUBLIC_URL`；Lume 读不到 Host 头，不配就只能拼 `http://127.0.0.1:<LUME_PORT>`。
