// src/web/app.tsx — cicdkit Lume 控制台（React 18 + 原生 fetch）
//
// 页面：总览 / 项目 / 运行 / 部署 / 知识库。所有数据来自同源 Lume BFF（/api/*），
// 浏览器不持有 cicdkit 的 API Token。

import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import API, {
  Deployment,
  Diagnosis,
  FsEntry,
  Health,
  KBEntry,
  LLMConfig,
  Meta,
  Overview,
  Project,
  Run,
  RunLog,
  ScanCandidate,
  StageResult,
} from './api'

const ROUTES = ['overview', 'projects', 'runs', 'deployments', 'kb'] as const
type Route = (typeof ROUTES)[number]

const NAV: Array<{ key: Route; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'projects', label: '项目' },
  { key: 'runs', label: '运行' },
  { key: 'deployments', label: '部署' },
  { key: 'kb', label: '知识库' },
]

const ROLE_LABEL: Record<string, string> = {
  agent_operator: '操作员',
  agent_reviewer: '一审',
  agent_reviewer_second: '二审',
  human_admin: '终审',
}

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  success: '成功',
  failed: '失败',
  canceled: '已取消',
}

const METHOD_LABEL: Record<string, string> = {
  'local-k3s': '本地 k3s',
  ssh: 'SSH 主机',
  'kubectl-apply': 'kubectl apply',
  'kubectl-set-image': 'kubectl set-image',
  helm: 'Helm',
}

const PROBE_LABEL: Record<string, string> = {
  ok: '通过',
  skip: '跳过',
  fail: '未达标',
  err: '出错',
}

const ROLE_KEY = 'cicdkit_lume_role'

function readRole(): string {
  try {
    const r = localStorage.getItem(ROLE_KEY) || ''
    return ['agent_operator', 'agent_reviewer', 'agent_reviewer_second', 'human_admin'].includes(r)
      ? r
      : 'agent_operator'
  } catch {
    return 'agent_operator'
  }
}

function writeRole(role: string) {
  try {
    localStorage.setItem(ROLE_KEY, role)
  } catch {
    /* 隐私模式忽略 */
  }
}

function routeFromPath(): Route {
  const p = location.pathname.replace(/^\/+|\/+$/g, '')
  return (ROUTES as readonly string[]).includes(p) ? (p as Route) : 'overview'
}

function fmtTime(s?: string): string {
  if (!s) return '—'
  const t = new Date(s)
  if (isNaN(t.getTime()) || t.getFullYear() < 2000) return '—'
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

function fmtNumber(n?: number): string {
  return typeof n === 'number' ? n.toLocaleString('zh-CN') : '—'
}

function statusClass(status?: string): string {
  if (status === 'success' || status === 'ok') return 'badge ok'
  if (status === 'running') return 'badge run'
  if (status === 'queued') return 'badge queue'
  if (status === 'failed' || status === 'canceled' || status === 'err') return 'badge err'
  return 'badge gray'
}

function Badge({ status }: { status?: string }) {
  const label = STATUS_LABEL[status || ''] || PROBE_LABEL[status || ''] || status || '—'
  return <span className={statusClass(status)}>{label}</span>
}

function Spinner({ label }: { label: string }) {
  return <div className="empty"><span className="spin" /> {label}</div>
}

function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="errorbox">
      <div>
        <strong>请求失败</strong>
        <p>{error}</p>
      </div>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

// ---------- 总览 ----------

function StatCard({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className={`stat ${tone || ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

// 聚合接口降级时优先显示第一个非空的原因（项目/运行/部署三条上游调用各自独立失败）。
function overviewError(o: Overview): string {
  const e = o.errors || {}
  return e.projects || e.runs || e.deployments || '上游不可达'
}

function OverviewPage({ role }: { role: string }) {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await API.overview())
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const t = window.setInterval(load, 15000)
    return () => window.clearInterval(t)
  }, [load])

  if (loading && !data) return <Spinner label="正在聚合上游数据…" />
  if (error) return <ErrorBox error={error} onRetry={load} />
  if (!data) return null

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>总览</h1>
          <p className="muted">
            上游 <code>{data.upstream}</code>{' '}
            {data.connected ? <span className="dot ok" /> : <span className="dot err" />}
            {data.connected ? '在线' : '不可用'}
          </p>
          {/* 聚合接口按 5s 降级：连不上时拿到的是「部分数据 + connected:false」，把上游给的原因显示出来 */}
          {data.connected ? null : (
            <p className="muted">上游错误：{overviewError(data)}</p>
          )}
        </div>
        <button className="btn" onClick={load}>
          刷新
        </button>
      </div>

      <div className="stats">
        <StatCard label="项目" value={fmtNumber(data.projects)} />
        <StatCard label="运行记录" value={fmtNumber(data.runs)} />
        <StatCard label="运行中" value={fmtNumber(data.running)} tone={data.running ? 'warn' : ''} />
        <StatCard label="失败 / 取消" value={fmtNumber(data.failed)} tone={data.failed ? 'bad' : ''} />
        <StatCard label="部署记录" value={fmtNumber(data.deployments)} />
      </div>

      <div className="grid2">
        <section className="panel">
          <div className="panel-head">
            <h2>最近运行</h2>
          </div>
          {data.recent_runs.length === 0 ? (
            <div className="empty">还没有运行记录</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>状态</th>
                  <th>触发</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.project_name || r.project_id}</td>
                    <td><Badge status={r.status} /></td>
                    <td className="muted">{r.trigger === 'webhook' ? 'Webhook' : '手动'}</td>
                    <td className="muted">{fmtTime(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>最近部署</h2>
          </div>
          {data.recent_deployments.length === 0 ? (
            <div className="empty">还没有部署记录</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>方式</th>
                  <th>状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {data.recent_deployments.map((d) => (
                  <tr key={d.id}>
                    <td>{d.project_name || d.project_id}</td>
                    <td className="muted">{d.target || METHOD_LABEL[d.method || ''] || d.method || '—'}</td>
                    <td><Badge status={d.status} /></td>
                    <td className="muted">{fmtTime(d.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <p className="muted small">当前操作角色：{ROLE_LABEL[role] || role}（仅发布闸门使用）</p>
    </div>
  )
}

// ---------- 项目 ----------

type Notice = { id: string; kind: 'ok' | 'err'; text: string }

function ProjectsPage({ role }: { role: string }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [editing, setEditing] = useState<Project | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const page = await API.listProjects()
      setProjects(page.projects || [])
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.repository || '').toLowerCase().includes(needle) ||
        (p.description || '').toLowerCase().includes(needle),
    )
  }, [projects, q])

  const trigger = async (p: Project, action: 'build' | 'pipeline' | 'validate' | 'deploy') => {
    if (action === 'deploy' && !window.confirm(`确认发布「${p.name}」？\n角色：${ROLE_LABEL[role] || role}`)) {
      return
    }
    setBusy(p.id + ':' + action)
    setNotice(null)
    try {
      const res: any =
        action === 'deploy' ? await API.deploy(p.id, role) : await API.action(p.id, action, role)
      const run = res && (res.run || res)
      const runId = run && typeof run === 'object' ? run.id : ''
      const label = action === 'deploy' ? '发布' : action === 'build' ? '构建' : action === 'pipeline' ? '流水线' : '验证'
      setNotice({
        id: p.id,
        kind: 'ok',
        text: runId ? `${label}已触发，运行 ${runId}` : `${label}已触发`,
      })
      load()
    } catch (e: any) {
      setNotice({ id: p.id, kind: 'err', text: e.message || String(e) })
    } finally {
      setBusy('')
    }
  }

  // 补脚手架：先预览，确认后才落盘（已有文件永不覆盖，所以可以放心点）
  const scaffold = async (p: Project) => {
    setBusy(p.id + ':generate')
    setNotice(null)
    try {
      const plan = await API.generate(p.id, false, role)
      if (!plan.needs_any) {
        setNotice({ id: p.id, kind: 'ok', text: 'Dockerfile / 清单都已存在，无需补齐' })
        return
      }
      const files: string[] = []
      if (plan.dockerfile) files.push(plan.dockerfile.path)
      if (plan.manifest) files.push(plan.manifest.path)
      if (!window.confirm(`将为「${p.name}」生成：\n\n${files.join('\n')}\n\n已有文件不会被覆盖。继续？`)) {
        return
      }
      await API.generate(p.id, true, role)
      setNotice({ id: p.id, kind: 'ok', text: `已生成 ${files.length} 个文件` })
      load()
    } catch (e: any) {
      setNotice({ id: p.id, kind: 'err', text: e.message || String(e) })
    } finally {
      setBusy('')
    }
  }

  const remove = async (p: Project) => {
    if (!window.confirm(`删除项目「${p.name}」？\n运行/部署历史会保留，但项目配置不可恢复。`)) return
    setBusy(p.id + ':delete')
    setNotice(null)
    try {
      await API.deleteProject(p.id, role)
      setNotice({ id: p.id, kind: 'ok', text: '项目已删除' })
      load()
    } catch (e: any) {
      setNotice({ id: p.id, kind: 'err', text: e.message || String(e) })
    } finally {
      setBusy('')
    }
  }

  if (loading && projects.length === 0) return <Spinner label="正在读取项目…" />
  if (error) return <ErrorBox error={error} onRetry={load} />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>项目</h1>
          <p className="muted">
            共 {projects.length} 个，操作角色 {ROLE_LABEL[role] || role}
          </p>
        </div>
        <div className="row">
          <input
            className="input"
            placeholder="按名称 / 仓库过滤…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn" onClick={load}>
            刷新
          </button>
          <button className="btn primary" onClick={() => setCreating(true)}>
            新建项目
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">没有匹配的项目</div>
      ) : (
        <div className="cards">
          {filtered.map((p) => {
            const last = p.last_deploy
            return (
              <article className="card" key={p.id}>
                <header className="card-head">
                  <div>
                    <h2>{p.name}</h2>
                    <div className="muted small">{p.id}</div>
                  </div>
                  <span className="chip">{METHOD_LABEL[p.deploy?.method || ''] || p.deploy?.method || '未配置'}</span>
                </header>

                {p.description && <p className="card-desc">{p.description}</p>}

                <dl className="meta">
                  <div>
                    <dt>仓库</dt>
                    <dd className="mono">{p.repository || '—'}</dd>
                  </div>
                  <div>
                    <dt>分支</dt>
                    <dd>{p.branch || '—'}</dd>
                  </div>
                  <div>
                    <dt>镜像</dt>
                    <dd className="mono">{p.build?.image_repo || '—'}</dd>
                  </div>
                  <div>
                    <dt>最近发布</dt>
                    <dd>
                      {last ? (
                        <>
                          {fmtTime(last.at)} · {last.target || METHOD_LABEL[last.method || ''] || last.method || '—'}
                        </>
                      ) : (
                        '尚未发布'
                      )}
                    </dd>
                  </div>
                </dl>

                <div className="row wrap card-actions">
                  <button
                    className="btn"
                    disabled={busy !== ''}
                    onClick={() => trigger(p, 'build')}
                  >
                    {busy === p.id + ':build' ? '构建中…' : '构建'}
                  </button>
                  <button
                    className="btn primary"
                    disabled={busy !== ''}
                    onClick={() => trigger(p, 'deploy')}
                  >
                    {busy === p.id + ':deploy' ? '发布中…' : '发布'}
                  </button>
                  <button
                    className="btn"
                    disabled={busy !== ''}
                    onClick={() => trigger(p, 'pipeline')}
                  >
                    {busy === p.id + ':pipeline' ? '执行中…' : '流水线'}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy !== ''}
                    onClick={() => trigger(p, 'validate')}
                  >
                    {busy === p.id + ':validate' ? '校验中…' : '校验'}
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy !== ''}
                    onClick={() => scaffold(p)}
                  >
                    {busy === p.id + ':generate' ? '生成中…' : '补脚手架'}
                  </button>
                  <button className="btn ghost" disabled={busy !== ''} onClick={() => setEditing(p)}>
                    编辑
                  </button>
                  <button
                    className="btn ghost"
                    disabled={busy !== ''}
                    onClick={() => remove(p)}
                  >
                    {busy === p.id + ':delete' ? '删除中…' : '删除'}
                  </button>
                </div>

                {notice && notice.id === p.id && (
                  <div className={notice.kind === 'ok' ? 'notice ok' : 'notice err'}>{notice.text}</div>
                )}
              </article>
            )
          })}
        </div>
      )}

      {creating && (
        <NewProjectModal
          role={role}
          onClose={() => setCreating(false)}
          onSaved={(created) => {
            setCreating(false)
            setNotice({ id: created.id, kind: 'ok', text: '项目已创建，接下来可以补部署配置' })
            load()
          }}
        />
      )}

      {editing && (
        <EditProjectModal
          project={editing}
          role={role}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setNotice({ id: editing.id, kind: 'ok', text: '项目配置已保存' })
            load()
          }}
        />
      )}
    </div>
  )
}

// ---------- 服务器目录选择器 ----------

// 浏览器拿不到服务器上的真实路径，只能让上游在自己的 FS_ROOTS 范围内列目录。
// 这就是「构建上下文不存在」那类失败的根源：旧流程靠手打绝对路径。
function parentDir(p: string): string {
  const s = p.replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i <= 0 ? '/' : s.slice(0, i)
}

function joinDir(base: string, name: string): string {
  const b = base.replace(/\/+$/, '')
  return b === '' ? '/' + name : b + '/' + name
}

function DirPicker({
  role,
  initial,
  onPick,
  onClose,
}: {
  role: string
  initial?: string
  onPick: (dir: string) => void
  onClose: () => void
}) {
  const [roots, setRoots] = useState<string[]>([])
  const [dir, setDir] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadDir = useCallback(
    async (target: string) => {
      if (!target) return
      setLoading(true)
      setError('')
      try {
        const res = await API.fsList(target, role)
        setDir(res.dir || target)
        setEntries(res.entries || [])
      } catch (e: any) {
        setError(e.message || String(e))
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [role],
  )

  const go = (target: string) => {
    setDir(target)
    loadDir(target)
  }

  useEffect(() => {
    let alive = true
    API.fsRoots(role)
      .then((r) => {
        if (!alive) return
        const list = r.roots || []
        setRoots(list)
        const start = initial && initial.trim() ? initial.trim() : list[0] || ''
        if (start) {
          setDir(start)
          loadDir(start)
        } else {
          setLoading(false)
        }
      })
      .catch((e: any) => {
        if (!alive) return
        setError(e.message || String(e))
        setLoading(false)
      })
    return () => {
      alive = false
    }
    // initial 只在打开弹窗时决定起点，之后由用户导航
  }, [role, loadDir])

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>选择服务器目录</h3>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small" style={{ margin: 0 }}>
            这里列的是 <strong>cicdkit 所在机器</strong>的目录，不是运行浏览器的那台。
            只能浏览上游配置的允许根目录（<code>FS_ROOTS</code>）。
          </p>

          {roots.length > 0 && (
            <div className="fs-roots">
              {roots.map((r) => (
                <button
                  key={r}
                  className={dir === r || dir.startsWith(r.replace(/\/+$/, '') + '/') ? 'chip on' : 'chip'}
                  onClick={() => go(r)}
                  title={r}
                >
                  {r}
                </button>
              ))}
            </div>
          )}

          <div className="fs-path">
            <button className="btn ghost" disabled={!dir || dir === '/'} onClick={() => go(parentDir(dir))}>
              上一级
            </button>
            <code className="mono">{dir || '—'}</code>
            <button className="btn primary" disabled={!dir} onClick={() => onPick(dir)}>
              选择此目录
            </button>
          </div>

          {error && <div className="notice err">{error}</div>}

          {loading ? (
            <div className="empty">
              <span className="spin" /> 读取目录…
            </div>
          ) : (
            <div className="fs-list">
              {entries.length === 0 ? (
                <div className="empty">这个目录是空的</div>
              ) : (
                entries.map((e) => (
                  <div
                    key={e.name}
                    className={e.is_dir ? 'fs-item' : 'fs-item file'}
                    title={joinDir(dir, e.name)}
                    onClick={() => {
                      if (e.is_dir) go(joinDir(dir, e.name))
                    }}
                  >
                    <span className="fs-icon">{e.is_dir ? '📁' : '📄'}</span>
                    <span className="mono">{e.name}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 编辑项目配置 ----------

// 上游 PUT /api/projects/:id 是整份替换：这里从 getProject 读完整对象，
// 只改表单覆盖的字段，再整份写回，避免把 targets / probe 清空。
// 保存要求顶栏角色是「终审」（?role=human_admin）。
// ---------- 新建项目 ----------
//
// 取代 cicdkit 之后，新增项目必须从界面走（原来靠 cicdkit 的「采纳诊断」顺带建项目）。
// 表单只覆盖必填项：其余字段（build_args / helm_values / targets）留给「编辑」补。
// 「扫描」把工作目录里像项目的目录列出来，点一下就把路径填好——手打绝对路径是
// 「构建上下文不存在」这类失败的头号来源。
function NewProjectModal({
  role,
  onClose,
  onSaved,
}: {
  role: string
  onClose: () => void
  onSaved: (created: Project) => void
}) {
  const [name, setName] = useState('')
  const [pid, setPid] = useState('')
  const [repo, setRepo] = useState('')
  const [context, setContext] = useState('')
  const [dockerfile, setDockerfile] = useState('')
  const [imageRepo, setImageRepo] = useState('')
  const [push, setPush] = useState(false)
  const [method, setMethod] = useState('ssh')
  const [ns, setNs] = useState('')
  const [deployment, setDeployment] = useState('')
  const [container, setContainer] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshUser, setSshUser] = useState('')
  const [sshContainer, setSshContainer] = useState('')
  const [probePort, setProbePort] = useState('')
  const [containerPort, setContainerPort] = useState('')
  const [candidates, setCandidates] = useState<ScanCandidate[]>([])
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setScanning(true)
    API.scanProjects('', role)
      .then((r) => {
        if (alive) setCandidates((r.candidates || []).filter((c) => !c.exists))
      })
      .catch(() => {
        // 扫描失败不影响手工填写，静默即可（角色不够时也是这里）
      })
      .finally(() => {
        if (alive) setScanning(false)
      })
    return () => {
      alive = false
    }
  }, [role])

  const pick = (c: ScanCandidate) => {
    setName(c.name)
    setPid(c.id)
    setContext(c.path)
    setImageRepo(c.id)
    if (c.dockerfile) setDockerfile(c.dockerfile)
    if (!sshContainer) setSshContainer(c.id)
    if (!container) setContainer('app')
  }

  const save = async () => {
    if (!name.trim()) {
      setError('名称必填')
      return
    }
    setSaving(true)
    setError('')
    try {
      const project: Project = {
        id: pid.trim(),
        name: name.trim(),
        repository: repo.trim(),
        build: {
          context: context.trim(),
          dockerfile: dockerfile.trim(),
          image_repo: imageRepo.trim(),
          tag_strategy: 'timestamp',
          push,
        },
        deploy:
          method === 'ssh'
            ? {
                method,
                ssh_host: sshHost.trim(),
                ssh_user: sshUser.trim(),
                ssh_container: sshContainer.trim(),
                ssh_probe_port: probePort.trim(),
                ssh_container_port: containerPort.trim(),
              }
            : method === 'kubectl-apply' || method === 'kubectl-set-image' || method === 'helm'
              ? { method, namespace: ns.trim(), deployment: deployment.trim(), container: container.trim() }
              : { method },
      }
      const created = await API.createProject(project, role)
      onSaved(created)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>新建项目</h3>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {candidates.length > 0 && (
            <div className="fld">
              <span>工作目录里的候选（点一下自动填路径）</span>
              <div className="row wrap">
                {candidates.map((c) => (
                  <button key={c.id} className="btn ghost" type="button" onClick={() => pick(c)}>
                    {c.name}
                    {c.has_manifests ? ' · 有部署目录' : ''}
                  </button>
                ))}
              </div>
              <span className="muted small">
                {scanning ? '扫描中…' : '只列出带 Dockerfile 或 deploy/ chart/ k8s/ 的目录'}
              </span>
            </div>
          )}

          <div className="row wrap">
            <label className="fld grow">
              <span>名称</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="fld">
              <span>ID（留空自动生成）</span>
              <input
                className="input mono"
                value={pid}
                onChange={(e) => setPid(e.target.value)}
                placeholder="会出现在容器名与运行 ID 里"
              />
            </label>
          </div>

          <label className="fld">
            <span>仓库</span>
            <input className="input mono" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </label>

          <label className="fld">
            <span>构建上下文（绝对路径）</span>
            <input
              className="input mono"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="/绝对/路径"
            />
          </label>

          <label className="fld">
            <span>Dockerfile</span>
            <input
              className="input mono"
              value={dockerfile}
              onChange={(e) => setDockerfile(e.target.value)}
              placeholder="Dockerfile"
            />
          </label>

          <div className="row wrap">
            <label className="fld grow">
              <span>镜像仓库</span>
              <input
                className="input mono"
                value={imageRepo}
                onChange={(e) => setImageRepo(e.target.value)}
                placeholder="registry/ns/name"
              />
            </label>
            <label className="fld">
              <span>部署方式</span>
              <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                {Object.entries(METHOD_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="chk-row">
            <input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} />
            <span>构建后推送镜像</span>
          </label>

          {method === 'ssh' && (
            <div className="row wrap">
              <label className="fld grow">
                <span>SSH 主机</span>
                <input className="input mono" value={sshHost} onChange={(e) => setSshHost(e.target.value)} />
              </label>
              <label className="fld">
                <span>SSH 用户</span>
                <input
                  className="input"
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  placeholder="留空用 CICD_SSH_USER"
                />
              </label>
              <label className="fld">
                <span>容器名</span>
                <input className="input" value={sshContainer} onChange={(e) => setSshContainer(e.target.value)} />
              </label>
              <label className="fld">
                <span>宿主端口</span>
                <input className="input" value={probePort} onChange={(e) => setProbePort(e.target.value)} />
              </label>
              <label className="fld">
                <span>容器端口</span>
                <input className="input" value={containerPort} onChange={(e) => setContainerPort(e.target.value)} />
              </label>
            </div>
          )}

          {(method === 'kubectl-apply' || method === 'kubectl-set-image' || method === 'helm') && (
            <div className="row wrap">
              <label className="fld">
                <span>命名空间</span>
                <input className="input" value={ns} onChange={(e) => setNs(e.target.value)} />
              </label>
              <label className="fld grow">
                <span>Deployment</span>
                <input className="input" value={deployment} onChange={(e) => setDeployment(e.target.value)} />
              </label>
              <label className="fld">
                <span>容器</span>
                <input className="input" value={container} onChange={(e) => setContainer(e.target.value)} />
              </label>
            </div>
          )}

          {error && <div className="notice err">{error}</div>}
          <span className="muted small">
            新建需要 human_admin 角色；创建后可到「编辑」补 build_args / targets / helm 参数。
          </span>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EditProjectModal({
  project,
  role,
  onClose,
  onSaved,
}: {
  project: Project
  role: string
  onClose: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    let alive = true
    API.getProject(project.id)
      .then((p) => {
        if (alive) setDraft(p)
      })
      .catch((e: any) => {
        if (alive) setError(e.message || String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [project.id])

  const patch = (next: Partial<Project>) => setDraft((d) => (d ? { ...d, ...next } : d))
  const patchBuild = (next: Partial<NonNullable<Project['build']>>) =>
    setDraft((d) => (d ? { ...d, build: { ...(d.build || {}), ...next } } : d))

  const save = async () => {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      await API.updateProject(draft.id, draft, role)
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setSaving(false)
    }
  }

  const build: NonNullable<Project['build']> = draft?.build || {}

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>编辑项目 · {draft?.name || project.name}</h3>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {loading ? (
            <div className="empty">
              <span className="spin" /> 读取项目配置…
            </div>
          ) : !draft ? (
            <div className="notice err">{error || '无法读取该项目'}</div>
          ) : (
            <>
              <label className="fld">
                <span>名称</span>
                <input className="input" value={draft.name || ''} onChange={(e) => patch({ name: e.target.value })} />
              </label>
              <label className="fld">
                <span>描述</span>
                <input
                  className="input"
                  value={draft.description || ''}
                  onChange={(e) => patch({ description: e.target.value })}
                />
              </label>
              <div className="row wrap">
                <label className="fld grow">
                  <span>仓库</span>
                  <input
                    className="input mono"
                    value={draft.repository || ''}
                    onChange={(e) => patch({ repository: e.target.value })}
                  />
                </label>
                <label className="fld">
                  <span>分支</span>
                  <input className="input" value={draft.branch || ''} onChange={(e) => patch({ branch: e.target.value })} />
                </label>
              </div>

              <div className="row wrap">
                <label className="fld grow">
                  <span>镜像仓库</span>
                  <input
                    className="input mono"
                    value={build.image_repo || ''}
                    onChange={(e) => patchBuild({ image_repo: e.target.value })}
                  />
                </label>
                <label className="fld">
                  <span>tag 策略</span>
                  <input
                    className="input"
                    value={build.tag_strategy || ''}
                    onChange={(e) => patchBuild({ tag_strategy: e.target.value })}
                    placeholder="timestamp / git-sha"
                  />
                </label>
              </div>

              <label className="fld">
                <span>构建上下文（服务器绝对路径）</span>
                <div className="row">
                  <input
                    className="input mono grow"
                    value={build.context || ''}
                    onChange={(e) => patchBuild({ context: e.target.value })}
                    placeholder="/绝对/路径"
                  />
                  <button className="btn" type="button" onClick={() => setPicking(true)}>
                    浏览目录
                  </button>
                </div>
                <span className="muted small">
                  路径写错会直接失败在「构建上下文不存在」；用「浏览目录」从上游机器的允许根目录里选。
                </span>
              </label>

              <label className="fld">
                <span>Dockerfile（相对上下文或绝对路径）</span>
                <input
                  className="input mono"
                  value={build.dockerfile || ''}
                  onChange={(e) => patchBuild({ dockerfile: e.target.value })}
                  placeholder="Dockerfile"
                />
              </label>

              <label className="chk-row">
                <input
                  type="checkbox"
                  checked={!!build.push}
                  onChange={(e) => patchBuild({ push: e.target.checked })}
                />
                <span>构建后推送镜像</span>
              </label>

              {role !== 'human_admin' && (
                <div className="notice err">
                  保存需要把顶栏角色切到「终审」（?role=human_admin）：项目配置决定构建从哪里取上下文、往哪里发布。
                </div>
              )}
              {error && <div className="notice err">{error}</div>}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={loading || saving || !draft}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      {/* 目录选择器嵌在编辑弹窗的遮罩里：拦掉冒泡，否则点它会把编辑框一起关掉 */}
      {picking && draft && (
        <div onClick={(e) => e.stopPropagation()}>
          <DirPicker
            role={role}
            initial={build.context}
            onPick={(dir) => {
              patchBuild({ context: dir })
              setPicking(false)
            }}
            onClose={() => setPicking(false)}
          />
        </div>
      )}
    </div>
  )
}

// ---------- 运行日志抽屉 ----------

function RunDrawer({
  runId,
  role,
  onClose,
  onChanged,
}: {
  runId: string
  role: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [detail, setDetail] = useState<Run | null>(null)
  const [logText, setLogText] = useState('')
  const [status, setStatus] = useState('')
  const [stages, setStages] = useState<StageResult[]>([])
  const [probe, setProbe] = useState<RunLog['probe']>(undefined)
  const [error, setError] = useState('')
  const [canceling, setCanceling] = useState(false)
  const [showDiag, setShowDiag] = useState(false)
  const fromRef = useRef(0)
  const preRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    let alive = true
    let timer: number | undefined
    fromRef.current = 0
    setLogText('')
    setError('')

    API.run(runId)
      .then((r) => {
        if (!alive) return
        setDetail(r)
        setStatus(r.status)
        setStages(r.stages || [])
      })
      .catch(() => {
        /* 日志接口会带 status/stages，详情失败不阻断 */
      })

    const tick = async () => {
      try {
        const d = await API.runLog(runId, fromRef.current)
        if (!alive) return
        if (d.reset) {
          setLogText(d.log || '')
        } else {
          setLogText((prev) => prev + (d.log || ''))
        }
        fromRef.current = d.log_len || 0
        setStatus(d.status || '')
        if (d.stages) setStages(d.stages)
        setProbe(d.probe)
        if (d.status === 'running' || d.status === 'queued') {
          timer = window.setTimeout(tick, 1500)
        } else if (onChanged) {
          onChanged()
        }
      } catch (e: any) {
        if (alive) setError(e.message || String(e))
      }
    }
    tick()

    return () => {
      alive = false
      if (timer) window.clearTimeout(timer)
    }
  }, [runId])

  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logText])

  const cancel = async () => {
    if (!window.confirm('确认取消这次运行？')) return
    setCanceling(true)
    try {
      await API.cancelRun(runId, role)
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setCanceling(false)
    }
  }

  const active = status === 'running' || status === 'queued'

  return (
    <div className="drawer-mask" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <h2>{detail?.project_name || detail?.project_id || '运行'}</h2>
            <div className="muted small mono">{runId}</div>
          </div>
          <div className="row">
            <Badge status={status} />
            {status === 'failed' && !showDiag && (
              <button className="btn" onClick={() => setShowDiag(true)}>
                AI 诊断
              </button>
            )}
            {active && (
              <button className="btn danger" onClick={cancel} disabled={canceling}>
                {canceling ? '取消中…' : '取消'}
              </button>
            )}
            <button className="btn ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div className="drawer-meta">
          <span>触发：{detail?.trigger === 'webhook' ? 'Webhook' : '手动'}</span>
          <span>镜像：{detail?.image_ref || '—'}</span>
          <span>开始：{fmtTime(detail?.created_at)}</span>
          {probe && <span>探测：{PROBE_LABEL[probe.status || ''] || probe.status} {probe.status_code ? `(${probe.status_code})` : ''}</span>}
        </div>

        {stages.length > 0 && (
          <div className="stages">
            {stages.map((s, i) => (
              <div className="stage" key={`${s.name || 'stage'}-${i}`}>
                <Badge status={s.status} />
                <span>{s.name || `阶段 ${i + 1}`}</span>
              </div>
            ))}
          </div>
        )}

        {error && <div className="notice err">{error}</div>}

        {showDiag && <DiagnosePanel runId={runId} onClose={() => setShowDiag(false)} />}

        <pre className="log" ref={preRef}>
          {logText || '（日志为空：运行可能尚未开始，或上游历史记录没有日志）'}
        </pre>
      </aside>
    </div>
  )
}

// ---------- AI 故障诊断（可选 LLM：配置与模型调用都在上游 cicdkit） ----------

type DiagState =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | {
      kind: 'done'
      analysis: string
      cached: boolean
      cachedFromKb: boolean
      adopted: boolean
      rejected: boolean
      similar: KBEntry[]
    }

// 挂载即发起诊断：模型调用有成本，所以只在用户显式点「AI 诊断」后渲染。
function DiagnosePanel({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [state, setState] = useState<DiagState>({ kind: 'loading' })
  const [acting, setActing] = useState(false)

  useEffect(() => {
    let alive = true
    API.diagnoseRun(runId)
      .then((d: Diagnosis) => {
        if (!alive) return
        setState({
          kind: 'done',
          analysis: d.analysis || '',
          cached: !!d.cached,
          cachedFromKb: !!d.cached_from_kb,
          adopted: !!d.adopted,
          rejected: !!d.rejected,
          similar: Array.isArray(d.similar) ? d.similar : [],
        })
      })
      .catch((e: any) => {
        if (alive) setState({ kind: 'error', error: e.message || String(e) })
      })
    return () => {
      alive = false
    }
  }, [runId])

  const adopt = async (value: boolean) => {
    setActing(true)
    try {
      const res = await API.adoptDiagnosis(runId, value)
      setState((prev) =>
        prev.kind === 'done' ? { ...prev, adopted: !!res.adopted, rejected: !!res.rejected } : prev,
      )
    } catch (e: any) {
      setState({ kind: 'error', error: e.message || String(e) })
    } finally {
      setActing(false)
    }
  }

  return (
    <section className="diag">
      <div className="diag-head">
        <strong>
          AI 故障诊断
          {state.kind === 'done' && state.cached
            ? state.cachedFromKb
              ? '（复用知识库）'
              : '（缓存）'
            : ''}
        </strong>
        <button className="btn ghost" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="diag-body">
        {state.kind === 'loading' && (
          <div className="empty">
            <span className="spin" /> 正在分析失败日志，请稍候…
          </div>
        )}
        {state.kind === 'error' && (
          <div className="notice err">
            <strong>诊断失败：</strong>
            <div>{state.error}</div>
            <div className="muted small">
              检查「LLM 设置」里的 Base URL / API Key / Model 是否已填写并启用；或确认该运行确实处于失败状态。
            </div>
          </div>
        )}
        {state.kind === 'done' && (
          <>
            {state.cachedFromKb && (
              <div className="muted small">
                📚 本次直接复用知识库中已采纳的同类结论，未调用模型。
              </div>
            )}
            {state.cached && !state.cachedFromKb && (
              <div className="muted small">⚡ 本次为缓存结果，未重新调用模型。</div>
            )}
            <pre className="diag-result">{state.analysis || '（模型没有返回内容）'}</pre>
            <div className="row wrap">
              {state.adopted ? (
                <span className="chip">✓ 已采纳到知识库</span>
              ) : (
                <>
                  <button className="btn primary" disabled={acting} onClick={() => adopt(true)}>
                    ✓ 采纳并加入知识库
                  </button>
                  <button className="btn ghost" disabled={acting} onClick={() => adopt(false)}>
                    ✗ 不采纳
                  </button>
                </>
              )}
              {state.rejected && !state.adopted && (
                <span className="muted small">已标记为不采纳</span>
              )}
            </div>
            {state.similar.length > 0 && (
              <div className="diag-similar">
                <div className="muted small">知识库历史同类诊断 {state.similar.length} 条</div>
                {state.similar.map((e, i) => (
                  <div className="diag-similar-item" key={e.id || i}>
                    <div className="muted small">
                      {e.project_name || '未知项目'} · {e.stage || '—'} · 采纳 {e.adopted_count || 0} 次
                    </div>
                    {e.error_excerpt && <div className="mono small">{e.error_excerpt}</div>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

// ---------- LLM 设置 ----------

// 配置实际保存在上游 data/llm.json，这里只是编辑它；写入 / 测试连接需要
// 顶栏角色是「终审」，否则后端 403（防访客把 BaseURL 指向自己的地址）。
function LLMSettings({
  role,
  onClose,
  onSaved,
}: {
  role: string
  onClose: () => void
  onSaved: () => void
}) {
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [system, setSystem] = useState('')
  const [keySet, setKeySet] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    API.llmConfig()
      .then((c: LLMConfig) => {
        setEnabled(!!c.enabled)
        setBaseUrl(c.base_url || '')
        setModel(c.model || '')
        setSystem(c.system || c.default_system || '')
        setKeySet(!!c.api_key_set)
      })
      .catch((e: any) => setNotice({ ok: false, text: '读取配置失败：' + (e.message || e) }))
      .finally(() => setLoading(false))
  }, [])

  // 空 api_key 表示「沿用已存的值」：GET 从不回明文，用户不填就不改。
  const payload = () => {
    const out: Record<string, unknown> = { enabled, base_url: baseUrl, model, system }
    if (apiKey.trim() !== '') out.api_key = apiKey
    return out
  }

  const test = async () => {
    setTesting(true)
    setNotice(null)
    try {
      const res = await API.testLlm(payload(), role)
      setNotice({
        ok: true,
        text: '连接成功' + (res.reply ? `：模型回包「${res.reply}」` : ''),
      })
    } catch (e: any) {
      setNotice({ ok: false, text: e.message || String(e) })
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setNotice(null)
    try {
      const saved = await API.saveLlmConfig(payload(), role)
      setKeySet(!!saved.api_key_set)
      setApiKey('')
      onSaved()
      onClose()
    } catch (e: any) {
      setNotice({ ok: false, text: e.message || String(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>LLM 设置 · AI 故障诊断</h3>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small" style={{ margin: 0 }}>
            可选功能：构建 / 部署失败时，把失败阶段日志发给兼容 OpenAI 的对话接口，返回中文根因与修复建议。
            配置保存在上游 cicdkit 的 <code>data/llm.json</code>（权限 0600），API Key 不会回传到浏览器；
            日志外发前由上游把 IP / 主机名 / 本地路径替换为占位符。
          </p>
          {loading ? (
            <div className="empty">
              <span className="spin" /> 读取配置…
            </div>
          ) : (
            <>
              <label className="chk-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span>启用 AI 诊断</span>
              </label>
              <label className="fld">
                <span>Base URL（OpenAI 兼容，以 /v1 结尾）</span>
                <input
                  className="input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </label>
              <label className="fld">
                <span>API Key{keySet ? '（已设置，留空保持不变）' : ''}</span>
                <input
                  className="input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={keySet ? '•••••••• 不更改请留空' : 'sk-...'}
                />
              </label>
              <label className="fld">
                <span>Model</span>
                <input
                  className="input"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini / deepseek-chat / auto"
                />
              </label>
              <label className="fld">
                <span>系统提示词（留空则使用上游内置模板）</span>
                <textarea
                  className="input"
                  rows={10}
                  value={system}
                  onChange={(e) => setSystem(e.target.value)}
                />
              </label>
              {role !== 'human_admin' && (
                <div className="notice err">
                  保存 / 测试连接需要把顶栏角色切到「终审」（?role=human_admin）：这一层能改 Base URL
                  并使用已存密钥，不能让任意访客把密钥指向自己的地址。
                </div>
              )}
              {notice && (
                <div className={notice.ok ? 'notice ok' : 'notice err'}>{notice.text}</div>
              )}
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving || testing}>
            取消
          </button>
          <button
            className="btn"
            onClick={test}
            disabled={loading || saving || testing || !baseUrl || !model}
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button className="btn primary" onClick={save} disabled={loading || saving}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- 运行 ----------

function RunsPage({ role }: { role: string }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openRun, setOpenRun] = useState('')

  const load = useCallback(async () => {
    try {
      const page = await API.listRuns({ project_id: projectId || undefined, limit: 100 })
      setRuns(page.runs || [])
      setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    API.listProjects()
      .then((p) => setProjects(p.projects || []))
      .catch(() => setProjects([]))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 有活动运行时自动刷新列表。
  useEffect(() => {
    if (!runs.some((r) => r.status === 'running' || r.status === 'queued')) return
    const t = window.setInterval(load, 4000)
    return () => window.clearInterval(t)
  }, [runs, load])

  if (loading && runs.length === 0) return <Spinner label="正在读取运行记录…" />

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>运行</h1>
          <p className="muted">最近 100 条运行记录，点击行查看阶段与实时日志</p>
        </div>
        <div className="row">
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={load}>
            刷新
          </button>
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}

      {runs.length === 0 ? (
        <div className="empty">没有运行记录</div>
      ) : (
        <table className="table clickable">
          <thead>
            <tr>
              <th>项目</th>
              <th>状态</th>
              <th>触发</th>
              <th>镜像 tag</th>
              <th>开始</th>
              <th>结束</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} onClick={() => setOpenRun(r.id)}>
                <td>{r.project_name || r.project_id}</td>
                <td><Badge status={r.status} /></td>
                <td className="muted">{r.trigger === 'webhook' ? 'Webhook' : '手动'}</td>
                <td className="mono muted">{r.image_tag || '—'}</td>
                <td className="muted">{fmtTime(r.created_at)}</td>
                <td className="muted">{fmtTime(r.ended_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {openRun && (
        <RunDrawer runId={openRun} role={role} onClose={() => setOpenRun('')} onChanged={load} />
      )}
    </div>
  )
}

// ---------- 部署 ----------

function DeploymentsPage() {
  const [items, setItems] = useState<Deployment[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const page = await API.listDeployments({ project_id: projectId || undefined, limit: 100 })
      setItems(page.deployments || [])
      setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    API.listProjects()
      .then((p) => setProjects(p.projects || []))
      .catch(() => setProjects([]))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>部署</h1>
          <p className="muted">发布历史，按时间倒序</p>
        </div>
        <div className="row">
          <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn" onClick={load}>
            刷新
          </button>
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}
      {loading && items.length === 0 ? (
        <Spinner label="正在读取部署记录…" />
      ) : items.length === 0 ? (
        <div className="empty">没有部署记录</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>项目</th>
              <th>方式</th>
              <th>目标</th>
              <th>镜像</th>
              <th>状态</th>
              <th>时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id}>
                <td>{d.project_name || d.project_id}</td>
                <td className="muted">{METHOD_LABEL[d.method || ''] || d.method || '—'}</td>
                <td className="muted">{d.target || d.namespace || d.cluster || '—'}</td>
                <td className="mono muted small">{d.image_ref || '—'}</td>
                <td><Badge status={d.status} /></td>
                <td className="muted">{fmtTime(d.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ---------- 知识库 ----------

// 只读列表 + 删除：BFF 透传上游 /api/kb。新增条目只能通过运行页的「采纳」，
// 所以这里不提供手工新建/编辑，避免前端自己拼一条没有 signature 的记录。
function KBPage() {
  const [entries, setEntries] = useState<KBEntry[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState('')
  const [openId, setOpenId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await API.listKb(q.trim() || undefined)
      setEntries(res.entries || [])
      setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [q])

  useEffect(() => {
    load()
  }, [load])

  const remove = async (entry: KBEntry) => {
    if (!entry.id) return
    const label = `${entry.project_name || entry.project_id || entry.id} · ${entry.stage || '—'}`
    if (!window.confirm(`确认从知识库删除「${label}」？删除后同类失败不会再命中这条结论。`)) return
    setRemoving(entry.id)
    setNotice('')
    try {
      await API.removeKb(entry.id)
      setEntries((prev) => prev.filter((e) => e.id !== entry.id))
      setNotice('已删除该知识库条目')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setRemoving('')
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>知识库</h1>
          <p className="muted">已采纳的 AI 诊断，同类失败直接复用；新增只能来自运行页的「采纳」</p>
        </div>
        <div className="row">
          <input
            className="input"
            placeholder="按项目 / 阶段 / 报错过滤…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn" onClick={load} disabled={loading}>
            刷新
          </button>
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}
      {notice && <div className="notice ok">{notice}</div>}

      {loading && entries.length === 0 ? (
        <Spinner label="正在读取知识库…" />
      ) : entries.length === 0 ? (
        <div className="empty">
          {q.trim()
            ? '没有匹配的条目'
            : '知识库还是空的：在运行页打开失败运行 →「AI 诊断」→「采纳并加入知识库」'}
        </div>
      ) : (
        <>
          <p className="muted small">共 {entries.length} 条，点击行查看完整结论</p>
          <table className="table clickable">
            <thead>
              <tr>
                <th>项目</th>
                <th>阶段</th>
                <th>错误摘要</th>
                <th>采纳次数</th>
                <th>最近采纳</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => {
                const id = e.id || `kb-${i}`
                const expanded = openId === id
                return (
                  <Fragment key={id}>
                    <tr onClick={() => setOpenId(expanded ? '' : id)}>
                      <td>{e.project_name || e.project_id || '—'}</td>
                      <td className="muted">{e.stage || '—'}</td>
                      <td className="mono small">
                        <span className="kb-excerpt" title={e.error_excerpt || ''}>
                          {e.error_excerpt || '—'}
                        </span>
                      </td>
                      <td className="muted">{e.adopted_count ?? 1}</td>
                      <td className="muted">{fmtTime(e.adopted_at || e.created_at)}</td>
                      <td className="kb-actions">
                        <button
                          className="btn ghost"
                          onClick={(ev) => {
                            ev.stopPropagation()
                            setOpenId(expanded ? '' : id)
                          }}
                        >
                          {expanded ? '收起' : '结论'}
                        </button>
                        <button
                          className="btn danger"
                          disabled={!e.id || removing === e.id}
                          onClick={(ev) => {
                            ev.stopPropagation()
                            remove(e)
                          }}
                        >
                          {removing === e.id ? '删除中…' : '删除'}
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} className="kb-detail">
                          <pre>{e.diagnosis || '（没有结论文本）'}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

// ---------- App ----------

function App() {
  const [route, setRoute] = useState<Route>(routeFromPath())
  const [health, setHealth] = useState<Health | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [role, setRole] = useState<string>(readRole())
  const [showLLM, setShowLLM] = useState(false)

  const navigate = (next: Route) => {
    if (next === route) return
    history.pushState({}, '', next === 'overview' ? '/' : '/' + next)
    setRoute(next)
  }

  useEffect(() => {
    const onPop = () => setRoute(routeFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    const poll = () => {
      API.health()
        .then(setHealth)
        .catch(() => setHealth(null))
    }
    poll()
    const t = window.setInterval(poll, 20000)
    return () => window.clearInterval(t)
  }, [])

  const loadMeta = useCallback(() => {
    API.meta()
      .then(setMeta)
      .catch(() => setMeta(null))
  }, [])

  useEffect(() => {
    loadMeta()
  }, [loadMeta])

  const changeRole = (next: string) => {
    setRole(next)
    writeRole(next)
  }

  const approvalMode = meta?.approval.mode || 'off'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => navigate('overview')}>
          <span className="logo">◆</span>
          <div>
            <strong>cicdkit</strong>
            <span className="muted small"> · lume</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((n) => (
            <button
              key={n.key}
              className={route === n.key ? 'nav-item active' : 'nav-item'}
              onClick={() => navigate(n.key)}
            >
              {n.label}
            </button>
          ))}
        </nav>

        <div className="row">
          <label className="role">
            <span className="muted small">角色</span>
            <select className="input small" value={role} onChange={(e) => changeRole(e.target.value)}>
              {Object.keys(ROLE_LABEL).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </label>

          <span className={approvalMode === 'off' ? 'chip' : 'chip warn'} title="发布审批闸门（CICD_DEPLOY_APPROVAL）">
            闸门 {approvalMode}
          </span>

          <button
            className={meta?.llm?.enabled ? 'chip' : 'chip warn'}
            onClick={() => setShowLLM(true)}
            title={
              meta?.llm?.enabled
                ? `AI 诊断已启用：${meta.llm.base_url || ''} · ${meta.llm.model || ''}`
                : 'AI 诊断未配置，点击设置 LLM'
            }
          >
            LLM {meta?.llm?.enabled ? '开' : '未配置'}
          </button>

          <span className="health" title={health?.upstream || meta?.upstream || ''}>
            <span className={health?.ok ? 'dot ok' : 'dot err'} />
            {health ? (health.ok ? '上游在线' : '上游离线') : '检测中…'}
          </span>
        </div>
      </header>

      <main>
        {route === 'overview' && <OverviewPage role={role} />}
        {route === 'projects' && <ProjectsPage role={role} />}
        {route === 'runs' && <RunsPage role={role} />}
        {route === 'deployments' && <DeploymentsPage />}
        {route === 'kb' && <KBPage />}
      </main>

      {showLLM && (
        <LLMSettings role={role} onClose={() => setShowLLM(false)} onSaved={loadMeta} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
