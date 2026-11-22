// src/web/api.ts — 与 Lume BFF 通信（同源，无 Token、无 CORS）
//
// BFF 的错误统一是 { ok:false, error }；上游 cicdkit 的错误是 { error }。
// request() 把两者都归一成 Error，调用点只处理成功路径。

export interface LastDeploy {
  method?: string
  target?: string
  image_ref?: string
  at?: string
}

export interface Project {
  id: string
  name: string
  description?: string
  repository?: string
  branch?: string
  build?: {
    image_repo?: string
    tag_strategy?: string
    push?: boolean
    platforms?: string[]
    context?: string
    dockerfile?: string
  }
  deploy?: {
    method?: string
    namespace?: string
    deployment?: string
    container?: string
    kubeconfig?: string
    manifest_path?: string
    chart_path?: string
    release_name?: string
    helm_image_key?: string
    helm_set_image?: boolean
    k3s_import_cmd?: string
    wait?: boolean
    timeout?: string
    ssh_host?: string
    ssh_user?: string
    ssh_port?: string
    ssh_key_path?: string
    ssh_container?: string
    ssh_run_args?: string
    ssh_probe_port?: string
    ssh_container_port?: string
    ssh_command?: string
    ssh_pull?: boolean
    ssh_transfer?: boolean
    ssh_build_platforms?: string[]
  }
  targets?: Array<{ name: string; method?: string }>
  primary_target?: string
  probe?: { enabled?: boolean; url?: string }
  created_at?: string
  updated_at?: string
  last_deploy?: LastDeploy
  last_deploys?: Record<string, LastDeploy>
}

export interface StageResult {
  name?: string
  status?: string
  log?: string
}

export interface Run {
  id: string
  project_id: string
  project_name?: string
  trigger?: string
  image_tag?: string
  image_ref?: string
  stages?: StageResult[]
  status: string
  created_at?: string
  started_at?: string
  ended_at?: string
  log?: string
  probe?: { status?: string; status_code?: number; url?: string; latency_ms?: number }
}

export interface Deployment {
  id: string
  project_id: string
  project_name?: string
  image_ref?: string
  cluster?: string
  namespace?: string
  method?: string
  target?: string
  status?: string
  created_at?: string
  run_id?: string
}

export interface RunLog {
  log: string
  log_len: number
  status: string
  stages?: StageResult[]
  reset: boolean
  truncated?: boolean
  log_note?: string
  probe?: { status?: string; status_code?: number; url?: string; latency_ms?: number }
  diagnosis?: { text?: string; adopted?: boolean; rejected?: boolean }
}

export interface Overview {
  ok: boolean
  upstream: string
  connected: boolean
  projects: number
  runs: number
  deployments: number
  running: number
  failed: number
  recent_runs: Run[]
  recent_deployments: Deployment[]
  errors?: { projects?: string; runs?: string; deployments?: string }
}

export interface Health {
  ok: boolean
  service: string
  upstream: string
  upstream_status: number
  version?: unknown
  error: string
}

export interface LLMStatus {
  reachable?: boolean
  enabled?: boolean
  api_key_set?: boolean
  base_url?: string
  model?: string
}

export interface Meta {
  service: string
  upstream: string
  approval: { mode: string; chain: string[]; roles: string[]; auth?: string; default_role?: string }
  llm?: LLMStatus
}

// 上游 /api/config/llm 的掩码视图：api_key 永不回传，只有 api_key_set。
export interface LLMConfig {
  enabled: boolean
  base_url?: string
  model?: string
  system?: string
  default_system?: string
  api_key_set?: boolean
}

export interface KBEntry {
  id?: string
  project_id?: string
  project_name?: string
  stage?: string
  signature?: string
  error_keyword?: string
  error_excerpt?: string
  diagnosis?: string
  created_at?: string
  adopted_at?: string
  adopted_count?: number
}

export interface Diagnosis {
  analysis: string
  run_id?: string
  cached?: boolean
  cached_from_kb?: boolean
  adopted?: boolean
  rejected?: boolean
  similar?: KBEntry[]
}

export interface FsEntry {
  name: string
  is_dir: boolean
  size?: number
}

// 上游 /api/fs/list：dir 是解析后的绝对路径，entries 目录在前、文件在后。
export interface FsListing {
  dir: string
  entries: FsEntry[]
}

// 工作目录扫描结果：接管 cicdkit 后「新建项目」不再靠手打绝对路径
export interface ScanCandidate {
  id: string
  name: string
  path: string
  dockerfile: string
  has_git: boolean
  has_manifests: boolean
  exists: boolean
}

export interface ProjectPage {
  projects: Project[]
  total: number
}

export interface RunPage {
  runs: Run[]
  total: number
}

export interface Visits {
  configured?: boolean
  online?: boolean
  url?: string
  error?: string
  // 应用自己的 /api/visits 字段（总数 / 今日 / 独立访客等），原样透传
  [key: string]: unknown
}

export interface DeploymentPage {
  deployments: Deployment[]
  total: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const text = await r.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!r.ok) {
    const msg = (data && (data.error || data.err)) || r.statusText || `HTTP ${r.status}`
    throw new Error(msg)
  }
  return data as T
}

const ROLE_PASS_KEY = 'cicdkit_lume_role_pass'

// 控制面配了 CICD_ROLE_MAP 时，角色只能由口令反查，?role= 自报不再作数。
// 口令存在 localStorage，只在 query 里带 pass=（Lume 请求对象读不到请求头）。
export function readRolePass(): string {
  try {
    return localStorage.getItem(ROLE_PASS_KEY) || ''
  } catch {
    return ''
  }
}

export function writeRolePass(pass: string) {
  try {
    if (pass) localStorage.setItem(ROLE_PASS_KEY, pass)
    else localStorage.removeItem(ROLE_PASS_KEY)
  } catch {
    /* 隐私模式忽略 */
  }
}

const passPair = () => {
  const p = readRolePass()
  return p ? `pass=${encodeURIComponent(p)}` : ''
}

const roleQuery = (role?: string) => {
  const parts: string[] = []
  if (role) parts.push(`role=${encodeURIComponent(role)}`)
  const pass = passPair()
  if (pass) parts.push(pass)
  return parts.length ? `?${parts.join('&')}` : ''
}

export const API = {
  health: () => request<Health>('/api/health'),
  meta: () => request<Meta>('/api/meta'),
  overview: () => request<Overview>('/api/overview'),

  listProjects: (q?: string) =>
    request<ProjectPage>(`/api/projects?limit=200${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  getProject: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`),
  // 新建：id 可选，缺省由 name 净化得到；重名返回 409
  createProject: (project: Project, role?: string) =>
    request<Project>(`/api/projects${roleQuery(role)}`, {
      method: 'POST',
      body: JSON.stringify(project),
    }),
  // 扫描工作目录，列出「像项目」的目录（有 Dockerfile 或 deploy/ chart/ k8s/）
  scanProjects: (dir: string, role?: string) =>
    request<{ ok: boolean; root: string; candidates: ScanCandidate[] }>(
      `/api/projects/scan${roleQuery(role)}`,
      { method: 'POST', body: JSON.stringify({ dir }) },
    ),
  deleteProject: (id: string, role?: string) =>
    request<{ ok: boolean; deleted: string }>(
      `/api/projects/${encodeURIComponent(id)}${roleQuery(role)}`,
      { method: 'DELETE' },
    ),
  clearRuns: (role?: string) =>
    request<{ ok: boolean; deleted: number }>(`/api/runs${roleQuery(role)}`, { method: 'DELETE' }),
  clearDeployments: (role?: string) =>
    request<{ ok: boolean; deleted: number }>(`/api/deployments${roleQuery(role)}`, {
      method: 'DELETE',
    }),
  sshDefaults: () =>
    request<{
      user: string
      port: string
      key_path_set: boolean
      container: string
      container_port: string
      probe_port: string
      run_args: string
      command: string
    }>('/api/config/ssh-defaults'),

  // 上游 PUT 是整份替换：传入 getProject 读到的完整对象（改完再写回），
  // 不要只传表单字段，否则 targets / probe 会被清空。
  updateProject: (id: string, project: Project, role?: string) =>
    request<Project>(`/api/projects/${encodeURIComponent(id)}${roleQuery(role)}`, {
      method: 'PUT',
      body: JSON.stringify(project),
    }),
  // action: build | pipeline | validate | probe；deploy 单独走 approve 闸门。
  action: (id: string, action: string, role?: string, body?: unknown) =>
    request<unknown>(`/api/projects/${encodeURIComponent(id)}/${action}${roleQuery(role)}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),
  // 补脚手架：不传 apply 只预览（返回要写的文件内容，不落盘）
  generate: (id: string, apply: boolean, role?: string) =>
    request<{
      ok: boolean
      err?: string
      needs_any: boolean
      dockerfile?: { path: string; content: string } | null
      manifest?: { path: string; content: string } | null
      config_updates?: Record<string, string>
    }>(
      `/api/projects/${encodeURIComponent(id)}/generate${
        apply ? '?apply=1' + roleQuery(role).replace('?', '&') : roleQuery(role)
      }`,
      { method: 'POST' },
    ),
  deploy: (id: string, role: string, body?: unknown) =>
    request<unknown>(`/api/projects/${encodeURIComponent(id)}/deploy${roleQuery(role)}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),

  // 回滚用的版本列表（同一目标、去重、按时间倒序）
  deployVersions: (id: string, target?: string) =>
    request<{
      ok: boolean
      entries: { image_ref: string; target: string; created_ts: number; created_at?: string }[]
      total: number
    }>(`/api/projects/${encodeURIComponent(id)}/deploy-versions${target ? '?target=' + encodeURIComponent(target) : ''}`),

  // 回滚：不传 image_ref 就是"上一版"，传了就是指定历史版本
  rollback: (id: string, role: string, body?: unknown) =>
    request<{
      ok: boolean
      run_id?: string
      image_ref?: string
      target?: string
      rolled_back_from?: string
      error?: string
    }>(`/api/projects/${encodeURIComponent(id)}/rollback${roleQuery(role)}`, {
      method: 'POST',
      body: JSON.stringify(body || {}),
    }),

  // 归档（被 CICD_RUN_KEEP 收走的运行，可恢复）
  listArchive: () =>
    request<{
      entries: {
        id: string
        project_id: string
        project_name: string
        status: string
        image_ref: string
        archived_ts: number
        log_archived: boolean
        log_bytes: number
      }[]
      total: number
    }>('/api/runs/archive'),
  restoreRun: (id: string, role?: string) =>
    request<{ ok: boolean; restored: string; log_bytes: number }>(
      `/api/runs/${encodeURIComponent(id)}/restore${roleQuery(role)}`,
      { method: 'POST' },
    ),

  listRuns: (opts: { project_id?: string; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.project_id) p.set('project_id', opts.project_id)
    p.set('limit', String(opts.limit || 100))
    return request<RunPage>(`/api/runs?${p.toString()}`)
  },
  run: (id: string) => request<Run>(`/api/runs/${encodeURIComponent(id)}`),
  runLog: (id: string, from: number) =>
    request<RunLog>(`/api/runs/${encodeURIComponent(id)}/log?from=${from}`),
  cancelRun: (id: string, role?: string) =>
    request<unknown>(`/api/runs/${encodeURIComponent(id)}/cancel${roleQuery(role)}`, {
      method: 'POST',
      body: '{}',
    }),

  // ---- AI 故障诊断（可选 LLM）----
  // 读配置是掩码的（只有 api_key_set）；写入 / 测试连接走 human_admin 门禁。
  llmConfig: () => request<LLMConfig>('/api/config/llm'),
  saveLlmConfig: (cfg: Record<string, unknown>, role?: string) =>
    request<LLMConfig>(`/api/config/llm${roleQuery(role)}`, {
      method: 'PUT',
      body: JSON.stringify(cfg),
    }),
  testLlm: (cfg: Record<string, unknown>, role?: string) =>
    request<{ ok?: boolean; reply?: string }>(`/api/config/llm/test${roleQuery(role)}`, {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),
  // 上游做知识库匹配 + 日志脱敏 + 模型调用，结果缓存在运行记录上。
  diagnoseRun: (id: string, role?: string) =>
    request<Diagnosis>(`/api/runs/${encodeURIComponent(id)}/diagnose${roleQuery(role)}`, {
      method: 'POST',
      body: '{}',
    }),
  // 采纳会把结论写入上游知识库；重复诊断时可直接复用。
  adoptDiagnosis: (id: string, adopt: boolean) =>
    request<{ adopted?: boolean; rejected?: boolean; kb_id?: string }>(
      `/api/runs/${encodeURIComponent(id)}/diagnosis/adopt`,
      { method: 'POST', body: JSON.stringify({ adopt }) },
    ),

  // ---- 知识库：只读列表 + 删除（新增只能通过诊断「采纳」）----
  listKb: (q?: string) =>
    request<{ entries: KBEntry[] }>(`/api/kb${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  removeKb: (id: string) =>
    request<{ deleted: string }>(`/api/kb/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---- 服务器目录浏览（编辑 build.context，需 human_admin）----
  fsRoots: (role?: string) => request<{ roots: string[] }>(`/api/fs/roots${roleQuery(role)}`),
  fsList: (dir: string, role?: string) =>
    request<FsListing>(
      `/api/fs/list?dir=${encodeURIComponent(dir)}${roleQuery(role).replace('?', '&')}`,
    ),

  // 线上访客统计：代理到项目自己的 /api/visits?pin=。
  // configured:false = 项目没配域名/PIN（界面应静默隐藏）；
  // configured:true + online:false = 站点挂了（界面应显示断线，而不是 0）。
  projectVisits: (id: string) => request<Visits>(`/api/projects/${encodeURIComponent(id)}/visits`),

  deployment: (id: string) => request<Deployment>(`/api/deployments/${encodeURIComponent(id)}`),

  diagnoseDeployment: (id: string, role?: string) =>
    request<Diagnosis>(`/api/deployments/${encodeURIComponent(id)}/diagnose${roleQuery(role)}`, { method: 'POST' }),

  listDeployments: (opts: { project_id?: string; limit?: number } = {}) => {
    const p = new URLSearchParams()
    if (opts.project_id) p.set('project_id', opts.project_id)
    p.set('limit', String(opts.limit || 100))
    return request<DeploymentPage>(`/api/deployments?${p.toString()}`)
  },
}

export default API
