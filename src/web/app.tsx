// src/web/app.tsx — CICDKit 控制台（React 18 + 原生 fetch）
//
// 页面：总览 / 项目 / 运行 / 部署 / 云环境 / Agent(Text2SQL) / 知识库。所有数据来自同源 Lume BFF（/api/*），
// 浏览器不持有 cicdkit 的 API Token。

import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import API, {
  AgentResult,
  Deployment,
  Diagnosis,
  EnvironmentAction,
  EnvironmentGroup,
  FsEntry,
  Health,
  KBEntry,
  LLMConfig,
  Meta,
  Overview,
  AccessEvent,
  Project,
  Run,
  RunLog,
  ScanCandidate,
  StageResult,
} from './api'

const ROUTES = ['overview', 'projects', 'runs', 'deployments', 'environments', 'agent', 'kb', 'audit'] as const
type Route = (typeof ROUTES)[number]

const NAV: Array<{ key: Route; label: string }> = [
  { key: 'overview', label: '总览' },
  { key: 'projects', label: '项目' },
  { key: 'runs', label: '运行' },
  { key: 'deployments', label: '部署' },
  { key: 'environments', label: '云环境' },
  { key: 'agent', label: 'Agent' },
  { key: 'kb', label: '知识库' },
  { key: 'audit', label: '审计' },
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
  submitted: '已提交',
  submit_failed: '提交失败',
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

type DeployEnv = 'test' | 'prod' | ''

type DeployOption = {
  name: string
  spec: Project['deploy']
  env: DeployEnv
  envLabel: string
}

// 与后端 validate.target_env 保持同一套规则：显式 environment 优先，
// 现有目标按名称推断（腾讯云=测试、阿里云=生产）。target 名不在这里重复拼字符串。
function targetEnv(name: string, spec?: Project['deploy']): DeployEnv {
  const explicit = (spec?.environment || '').trim().toLowerCase()
  if (['test', 'testing', 'staging'].includes(explicit)) return 'test'
  if (['prod', 'production'].includes(explicit)) return 'prod'
  if (name.includes('腾讯')) return 'test'
  if (name.includes('阿里')) return 'prod'
  return ''
}

function envLabel(env: DeployEnv): string {
  return env === 'test' ? '测试' : env === 'prod' ? '生产' : '未定义'
}

function deployOptions(p: Project): DeployOption[] {
  if (p.targets && p.targets.length > 0) {
    return p.targets.map((t) => {
      const spec = t as Project['deploy']
      return { name: t.name, spec, env: targetEnv(t.name, spec), envLabel: envLabel(targetEnv(t.name, spec)) }
    })
  }
  const spec = p.deploy
  const env = targetEnv('', spec)
  return [{ name: '', spec, env, envLabel: envLabel(env) }]
}

// 生产目标配置里的端口只作历史参考，发布时必须重新填；测试目标缺省 8080。
function deployPortFor(opt: DeployOption): string {
  if (!targetNeedsPort(opt)) return ''
  if (opt.env === 'prod') return ''
  if (opt.env === 'test') return '8080'
  return opt.spec?.ssh_probe_port || ''
}

function targetNeedsPort(opt: DeployOption): boolean {
  const m = (opt.spec?.method || '').trim()
  return m === '' || m === 'ssh'
}


const ROLE_KEY = 'cicdkit_lume_role'
const ROLE_PASS_KEY = 'cicdkit_lume_role_pass'
// 服务端下发默认角色时只应用一次，之后用户在顶栏切换的选择继续生效。
const ROLE_DEFAULT_MARK = 'cicdkit_lume_role_default_applied'

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

function readRolePass(): string {
  try {
    return localStorage.getItem(ROLE_PASS_KEY) || ''
  } catch {
    return ''
  }
}

function writeRolePass(pass: string) {
  try {
    if (pass) localStorage.setItem(ROLE_PASS_KEY, pass)
    else localStorage.removeItem(ROLE_PASS_KEY)
  } catch {
    /* 隐私模式忽略 */
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
  if (status === 'failed' || status === 'canceled' || status === 'err' || status === 'submit_failed') return 'badge err'
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
  const [deploying, setDeploying] = useState<{ project: Project; action: 'deploy' | 'pipeline' } | null>(null)

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

  const trigger = async (p: Project, action: 'build' | 'validate') => {
    setBusy(p.id + ':' + action)
    setNotice(null)
    try {
      const res: any = await API.action(p.id, action, role)
      const run = res && (res.run || res)
      const runId = run && typeof run === 'object' ? run.id : ''
      const label = action === 'build' ? '构建' : '验证'
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

  // 回滚：先拉版本列表让用户选；直接确定 = 上一版，填序号 = 指定历史版本
  const rollback = async (p: Project) => {
    const cur = p.last_deploy
    const opts = deployOptions(p)
    const opt = opts.find((o) => o.name === (cur?.target || '')) || opts[0]
    let port = deployPortFor(opt)
    if (targetNeedsPort(opt) && opt.env === 'prod') {
      const input = window.prompt(`生产环境回滚「${p.name}」需要指定端口（1-65535）`, '')
      if (input === null) return
      port = input.trim()
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
        setNotice({ id: p.id, kind: 'err', text: `端口非法：${port || '空'}` })
        return
      }
    }
    setBusy(p.id + ':rollback')
    setNotice(null)
    try {
      const list = await API.deployVersions(p.id, cur?.target || '')
      const versions = list.entries || []
      if (versions.length === 0) {
        setNotice({ id: p.id, kind: 'err', text: '还没有成功发布记录，没有可回滚的版本' })
        return
      }
      const lines = versions
        .map((v, i) => `${i + 1}. ${v.image_ref}${v.image_ref === cur?.image_ref ? '（当前）' : ''}`)
        .join('\n')
      const pick = window.prompt(
        `回滚「${p.name}」到哪一版？\n直接确定 = 上一版，输入序号 = 指定历史版本\n\n${lines}\n\n目标：${
          cur?.target || '默认'
        }`,
        '',
      )
      if (pick === null) return
      const raw = pick.trim()
      let image = ''
      if (raw !== '') {
        const idx = Number(raw)
        const chosen = Number.isFinite(idx) ? versions[idx - 1] : undefined
        if (!chosen) {
          setNotice({ id: p.id, kind: 'err', text: `序号 ${raw} 不在版本列表里` })
          return
        }
        image = chosen.image_ref
      }
      if (!window.confirm(`确认回滚「${p.name}」？\n回滚到：${image || '上一版'}\n角色：${
        ROLE_LABEL[role] || role
      }`)) {
        return
      }
      const res = await API.rollback(p.id, role, { target: cur?.target || '', image_ref: image, port })
      setNotice({
        id: p.id,
        kind: 'ok',
        text: `回滚已触发：${res.image_ref || ''}（原 ${res.rolled_back_from || '—'}）${
          res.run_id ? '，运行 ' + res.run_id : ''
        }`,
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
                    onClick={() => setDeploying({ project: p, action: 'deploy' })}
                  >
                    {busy === p.id + ':deploy' ? '发布中…' : '发布'}
                  </button>
                  {p.last_deploy ? (
                    <button
                      className="btn ghost"
                      disabled={busy !== ''}
                      onClick={() => rollback(p)}
                      title="选一版发布回滚（默认上一版）"
                    >
                      {busy === p.id + ':rollback' ? '回滚中…' : '回滚…'}
                    </button>
                  ) : null}
                  <button
                    className="btn"
                    disabled={busy !== ''}
                    onClick={() => setDeploying({ project: p, action: 'pipeline' })}
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

      {deploying && (
        <DeployModal
          project={deploying.project}
          action={deploying.action}
          role={role}
          onClose={() => setDeploying(null)}
          onDone={(runId, label) => {
            setDeploying(null)
            setNotice({
              id: deploying.project.id,
              kind: 'ok',
              text: runId ? `${label}已触发，运行 ${runId}` : `${label}已触发`,
            })
            load()
          }}
        />
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

// ---------- 发布确认 ----------

// 发布/流水线共用：先选目标，再确认端口。
// 腾讯云测试目标默认 8080（现有 8081/8082 保留）；阿里云生产目标不读配置端口，必须手填。
function DeployModal({
  project,
  action,
  role,
  onClose,
  onDone,
}: {
  project: Project
  action: 'deploy' | 'pipeline'
  role: string
  onClose: () => void
  onDone: (runId: string, label: string) => void
}) {
  const options = useMemo(() => deployOptions(project), [project])
  const initial = options.find((o) => o.name === (project.primary_target || '')) || options[0]
  const [targetName, setTargetName] = useState(initial?.name || '')
  const [port, setPort] = useState(deployPortFor(initial))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const selected = options.find((o) => o.name === targetName) || initial
  const portRelevant = selected ? targetNeedsPort(selected) : false
  const portInvalid =
    portRelevant && port.trim() !== '' && (!/^\d+$/.test(port.trim()) || Number(port) < 1 || Number(port) > 65535)
  const needPort = portRelevant && selected.env === 'prod' && port.trim() === ''
  const disabled = busy || !selected || needPort || portInvalid

  const pickTarget = (name: string) => {
    const next = options.find((o) => o.name === name)
    setTargetName(name)
    setPort(next ? deployPortFor(next) : '')
    setError('')
  }

  const submit = async () => {
    if (disabled || !selected) return
    setBusy(true)
    setError('')
    const body = { target: selected.name, port: port.trim() }
    try {
      const res: any =
        action === 'deploy'
          ? await API.deploy(project.id, role, body)
          : await API.action(project.id, 'pipeline', role, body)
      const run = res && (res.run || res)
      const runId = run && typeof run === 'object' ? run.id : res?.run_id || ''
      onDone(runId, action === 'deploy' ? '发布' : '流水线')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{action === 'deploy' ? '发布' : '流水线'}「{project.name}」</h3>
          <button className="btn ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small" style={{ margin: 0 }}>
            测试目标默认使用 8080，可改；生产目标不保存端口，每次发布必须指定。
          </p>

          <label className="fld">
            <span>发布目标</span>
            <select className="input" value={targetName} onChange={(e) => pickTarget(e.target.value)}>
              {options.map((o) => (
                <option key={o.name || '__default'} value={o.name}>
                  {o.name || '默认发布目标'} · {o.envLabel}
                  {o.spec?.method ? ` · ${METHOD_LABEL[o.spec?.method || ''] || o.spec.method}` : ''}
                </option>
              ))}
            </select>
          </label>

          {selected && (
            <div className="deploy-target">
              <span className={selected.env === 'prod' ? 'env-pill prod' : selected.env === 'test' ? 'env-pill test' : 'env-pill'}>
                {selected.envLabel}
              </span>
              <span className="muted small">
                {selected.name || '默认发布目标'}
                {selected.spec?.ssh_host ? ` · ${selected.spec.ssh_host}` : ''}
                {selected.spec?.ssh_container_port ? ` · 容器端口 ${selected.spec.ssh_container_port}` : ''}
              </span>
            </div>
          )}

          {portRelevant ? (
            <label className="fld">
              <span>
                宿主端口
                {selected.env === 'prod'
                  ? '（生产必填）'
                  : selected.env === 'test'
                    ? '（默认 8080）'
                    : ''}
              </span>
              <input
                className="input"
                inputMode="numeric"
                placeholder={selected.env === 'prod' ? '例如 8095' : '8080'}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
          ) : (
            <div className="notice ok">该目标是 {METHOD_LABEL[selected.spec?.method || ''] || selected.spec?.method} 部署，不需要宿主端口。</div>
          )}

          {needPort && <div className="notice err">生产环境必须填写端口，配置里的旧端口不会作为默认值。</div>}
          {portInvalid && <div className="notice err">端口必须是 1-65535 的数字。</div>}
          {error && <div className="notice err">{error}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn primary" onClick={submit} disabled={disabled}>
            {busy ? '提交中…' : action === 'deploy' ? '确认发布' : '执行流水线'}
          </button>
        </div>
      </div>
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
            这里列的是 <strong>CICDKit 所在机器</strong>的目录，不是运行浏览器的那台。
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
  const [logNote, setLogNote] = useState('')
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
        setLogNote(d.log_note || '')
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

        {showDiag && <DiagnosePanel runId={runId} role={role} onClose={() => setShowDiag(false)} />}

        {logNote && <div className="notice warn">{logNote}</div>}
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
function DiagnosePanel({ runId, role, onClose }: { runId: string; role: string; onClose: () => void }) {
  const [state, setState] = useState<DiagState>({ kind: 'loading' })
  const [acting, setActing] = useState(false)

  useEffect(() => {
    let alive = true
    API.diagnoseRun(runId, role)
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
      const res = await API.adoptDiagnosis(runId, value, role)
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
  // 归档：被保留策略收走的运行，可以在这里恢复（服务端不删，只搬走）
  const [archive, setArchive] = useState<
    { id: string; project_name: string; status: string; image_ref: string; archived_ts: number; log_archived: boolean }[]
  >([])
  const [showArchive, setShowArchive] = useState(false)

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

  useEffect(() => {
    API.listArchive()
      .then((a) => setArchive(a.entries || []))
      .catch(() => setArchive([]))
  }, [runs.length])

  const restore = async (id: string) => {
    try {
      const r = await API.restoreRun(id, role)
      setArchive((prev) => prev.filter((x) => x.id !== id))
      setError(`已恢复 ${id}（日志 ${r.log_bytes} 字节）`)
      load()
    } catch (e: any) {
      setError(e.message || String(e))
    }
  }

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
          {archive.length > 0 ? (
            <button className="btn ghost" onClick={() => setShowArchive((v: boolean) => !v)}>
              {showArchive ? '收起归档' : `归档 ${archive.length}`}
            </button>
          ) : null}
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}

      {showArchive && archive.length > 0 ? (
        <div className="card" style={{ marginBottom: 16 }}>
          <p className="muted small">
            以下运行因超过保留条数（CICD_RUN_KEEP）被归档，按「恢复」可以连日志一起回到列表。
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>项目</th>
                <th>状态</th>
                <th>镜像</th>
                <th>归档时间</th>
                <th>日志</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {archive.map((a) => (
                <tr key={a.id}>
                  <td>{a.project_name || '—'}</td>
                  <td><Badge status={a.status} /></td>
                  <td className="mono muted">{a.image_ref || '—'}</td>
                  <td className="muted">{fmtTime(a.archived_ts ? new Date(a.archived_ts * 1000).toISOString() : '')}</td>
                  <td className="muted small">{a.log_archived ? '已归档' : '未归档'}</td>
                  <td>
                    <button className="btn ghost" onClick={() => restore(a.id)}>
                      恢复
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

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

function DeploymentsPage({ role }: { role: string }) {
  const [items, setItems] = useState<Deployment[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 部署记录本身不带日志，点行打开那次运行（RunDrawer 里能看日志、跑 AI 诊断）。
  const [openRun, setOpenRun] = useState('')

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
              <th>运行</th>
            </tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr
                key={d.id}
                onClick={() => d.run_id && setOpenRun(d.run_id)}
                style={d.run_id ? { cursor: 'pointer' } : undefined}
              >
                <td>{d.project_name || d.project_id}</td>
                <td className="muted">{METHOD_LABEL[d.method || ''] || d.method || '—'}</td>
                <td className="muted">{d.target || d.namespace || d.cluster || '—'}</td>
                <td className="mono muted small">{d.image_ref || '—'}</td>
                <td><Badge status={d.status} /></td>
                <td className="muted">{fmtTime(d.created_at)}</td>
                <td>
                  {d.run_id ? (
                    <button
                      className="btn ghost"
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenRun(d.run_id || '')
                      }}
                      title="打开这次运行：看日志 / AI 诊断"
                    >
                      查看 / 诊断
                    </button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
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

// ---------- 云环境（只读 + 受控动作） ----------

type SnapshotState = {
  loading: boolean
  status?: string
  exit?: number
  done?: boolean
  log?: string
  error?: string
  title?: string
}

const ENV_ACTION_LABEL: Record<string, string> = {
  'helm-history': 'Helm 历史',
  'rollout-restart': '滚动重启',
  'docker-logs': '容器日志',
  'docker-restart': '重启容器',
}

const ENV_ACTION_DESC: Record<string, string> = {
  'helm-history': '读取该 Helm release 最近 10 次 revision。只读，不改动集群。',
  'rollout-restart': '对该 Helm 工作负载执行 rollout restart，Pod 会重新拉起。',
  'docker-logs': '读取该 Docker 容器最近 200 行日志。只读，不改动容器。',
  'docker-restart': '重启该 Docker 容器，服务会短暂中断。',
}

function EnvActionModal({
  group,
  project,
  action,
  role,
  onClose,
  onDone,
}: {
  group: EnvironmentGroup
  project: EnvironmentGroup['projects'][number]
  action: string
  role: string
  onClose: () => void
  onDone: () => void
}) {
  const label = ENV_ACTION_LABEL[action] || action
  const desc = ENV_ACTION_DESC[action] || ''
  const mutation = action === 'rollout-restart' || action === 'docker-restart'
  const canMutate = role === 'human_admin'
  const blocked = mutation && !canMutate

  const modalRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)
  const [running, setRunning] = useState(false)
  const [jobId, setJobId] = useState('')
  const [status, setStatus] = useState('')
  const [exit, setExit] = useState(-1)
  const [done, setDone] = useState(false)
  const [log, setLog] = useState('')
  const [error, setError] = useState('')

  const close = () => {
    if (running) return
    onClose()
  }

  const run = async () => {
    setRunning(true)
    setError('')
    setLog('')
    setStatus('')
    setDone(false)
    try {
      const started = await API.environmentAction(
        group.host,
        { project_id: project.id, target: project.target || '', action },
        role || undefined,
      )
      setJobId(started.job_id)
      const deadline = Date.now() + 90000
      for (;;) {
        const st = await API.environmentSnapshotGet(started.job_id)
        setStatus(st.status)
        setExit(st.exit)
        setDone(st.done)
        setLog(st.log || '')
        if (st.error) setError(st.error)
        if (st.done) {
          setRunning(false)
          onDone()
          return
        }
        if (Date.now() > deadline) {
          setRunning(false)
          setError('动作读取超时；任务可能仍在远端执行，可用审计里的 job_id 排查')
          onDone()
          return
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch (e: any) {
      setRunning(false)
      setError(e.message || String(e))
      onDone()
    }
  }

  // 打开弹窗即执行；重启类动作仍受角色门禁。执行结果持续留在弹窗里。
  useEffect(() => {
    prevFocusRef.current = document.activeElement as HTMLElement | null
    modalRef.current?.focus()
    return () => {
      prevFocusRef.current?.focus?.()
    }
  }, [])

  useEffect(() => {
    if (blocked) return
    void run()
    // 只在首次挂载时触发，后续不再自动重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 弹窗打开时锁住母页面滚动，避免滚轮穿透。
  useEffect(() => {
    const body = document.body
    const prev = body.style.overflow
    body.style.overflow = 'hidden'
    return () => {
      body.style.overflow = prev
    }
  }, [])

  return (
    <div className="modal-mask" onClick={close}>
      <div
        className="modal"
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${label} ${project.name || project.id}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            close()
          }
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3>{label}「{project.name || project.id}」</h3>
          <button className="btn ghost" onClick={close} disabled={running}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small" style={{ margin: 0 }}>{desc}</p>

          <div className="deploy-target">
            <span className={project.environment === 'prod' ? 'env-pill prod' : project.environment === 'test' ? 'env-pill test' : 'env-pill'}>
              {project.environment === 'test' ? '测试' : project.environment === 'prod' ? '生产' : '未定义'}
            </span>
            <span className="muted small">
              {group.host} · {project.target || '默认目标'} · {METHOD_LABEL[project.method || ''] || project.method || '—'}
            </span>
          </div>

          {(project.namespace || project.release || project.container) && (
            <dl className="meta">
              {project.namespace && <div><dt>命名空间</dt><dd className="mono">{project.namespace}</dd></div>}
              {project.release && <div><dt>Release</dt><dd className="mono">{project.release}</dd></div>}
              {project.container && <div><dt>容器</dt><dd className="mono">{project.container}</dd></div>}
              {project.port && <div><dt>端口</dt><dd className="mono">{project.port}</dd></div>}
            </dl>
          )}

          {mutation && (
            <div className="notice err">
              这是会改变运行状态的动作，可能造成短暂中断；只允许终审角色执行。
              当前角色：{ROLE_LABEL[role] || role || '未知'}。
            </div>
          )}
          {blocked && <div className="notice err">当前角色不是终审，不能执行重启。请先在顶栏切换角色。</div>}
          {error && <div className="notice err">{error}</div>}

          {(jobId || log || running) && (
            <div className="env-action-result">
              <div className="env-snapshot-head">
                <strong>执行输出</strong>
                {running ? (
                  <Badge status="running" />
                ) : done ? (
                  <Badge status={exit === 0 ? 'success' : 'failed'} />
                ) : status ? (
                  <Badge status={status} />
                ) : null}
                {jobId && <span className="muted small mono">{jobId}</span>}
              </div>
              <pre className="env-log">{log || (running ? '等待远端输出…' : '')}</pre>
            </div>
          )}
        </div>
        <div className="modal-foot">
          {jobId ? (
            <button className="btn primary" onClick={close} disabled={running}>
              {running ? '执行中…' : '关闭'}
            </button>
          ) : (
            <>
              <button className="btn ghost" onClick={close} disabled={running}>
                取消
              </button>
              <button className={mutation ? 'btn danger' : 'btn primary'} onClick={run} disabled={running || blocked}>
                {running ? '执行中…' : mutation ? '确认重启' : '执行'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function EnvironmentsPage({ role }: { role: string }) {
  const [groups, setGroups] = useState<EnvironmentGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotState>>({})
  const [dialog, setDialog] = useState<{
    group: EnvironmentGroup
    project: EnvironmentGroup['projects'][number]
    action: string
  } | null>(null)
  const [audits, setAudits] = useState<Record<string, EnvironmentAction[]>>({})

  const refreshAudit = useCallback(async (host: string) => {
    try {
      const r = await API.listEnvironmentActions(host, 5)
      setAudits((prev) => ({ ...prev, [host]: r.actions || [] }))
    } catch {
      /* 审计读取失败不影响主视图 */
    }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await API.listEnvironments()
      const next = res.environments || []
      setGroups(next)
      next.forEach((g) => void refreshAudit(g.host))
      setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [refreshAudit])

  useEffect(() => {
    load()
  }, [load])

  // 固定只读快照：先提交 runner job，再轮询日志；不接收任何用户输入命令。
  const runSnapshot = async (host: string) => {
    setSnapshots((prev) => ({ ...prev, [host]: { loading: true } }))
    try {
      const started = await API.environmentSnapshot(host, role || undefined)
      const deadline = Date.now() + 90000
      for (;;) {
        const st = await API.environmentSnapshotGet(started.job_id)
        setSnapshots((prev) => ({
          ...prev,
          [host]: {
            loading: !st.done,
            status: st.status,
            exit: st.exit,
            done: st.done,
            log: st.log,
            error: st.error,
          },
        }))
        if (st.done) return
        if (Date.now() > deadline) {
          setSnapshots((prev) => ({ ...prev, [host]: { ...(prev[host] || {}), loading: false, error: '快照读取超时' } }))
          return
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
    } catch (e: any) {
      setSnapshots((prev) => ({
        ...prev,
        [host]: { loading: false, error: e.message || String(e) },
      }))
    }
  }

  const canMutate = role === 'human_admin'

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>云环境</h1>
          <p className="muted">按 SSH 主机聚合项目与最近部署；快照只读，日志/历史只读，重启类动作需终审</p>
        </div>
        <div className="row">
          <button className="btn" onClick={load} disabled={loading}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}
      {loading && groups.length === 0 ? (
        <Spinner label="正在聚合云环境…" />
      ) : groups.length === 0 ? (
        <div className="empty">还没有配置了 ssh_host 的发布目标</div>
      ) : (
        <div className="env-list">
          {groups.map((g) => {
            const snap = snapshots[g.host]
            const audit = audits[g.host] || []
            return (
              <section className="env-card" key={g.host}>
                <div className="env-head">
                  <div className="env-title">
                    <h2>{g.host}</h2>
                    <div className="env-sub">
                      <span className="mono">{g.user ? `${g.user}@` : ''}{g.host}{g.port ? `:${g.port}` : ''}</span>
                      {g.latest_at && <span className="muted small">最近发布 {fmtTime(g.latest_at)}</span>}
                    </div>
                  </div>
                  <div className="env-actions">
                    <span className="env-pill test">测试 {g.environments.test || 0}</span>
                    <span className="env-pill prod">生产 {g.environments.prod || 0}</span>
                    {(g.environments.other || 0) > 0 && <span className="env-pill">未定义 {g.environments.other}</span>}
                    <button className="btn ghost" onClick={() => runSnapshot(g.host)} disabled={snap?.loading}>
                      {snap?.loading ? '读取中…' : '只读快照'}
                    </button>
                  </div>
                </div>

                <div className="env-projects">
                  <table className="table compact">
                    <thead>
                      <tr>
                        <th>项目</th>
                        <th>目标</th>
                        <th>环境</th>
                        <th>方式</th>
                        <th>端口</th>
                        <th>最近发布</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.projects.map((p, idx) => (
                        <tr key={`${p.id}-${p.target || idx}`}>
                          <td>
                            <strong>{p.name || p.id}</strong>
                            {(p.namespace || p.release) && (
                              <div className="muted small mono">
                                {p.namespace || '—'}{p.release ? ` / ${p.release}` : ''}
                              </div>
                            )}
                          </td>
                          <td className="muted">{p.target || '—'}</td>
                          <td>
                            <span className={`env-pill ${p.environment || ''}`}>
                              {p.environment === 'test' ? '测试' : p.environment === 'prod' ? '生产' : '未定义'}
                            </span>
                          </td>
                          <td className="muted">{METHOD_LABEL[p.method || ''] || p.method || '—'}</td>
                          <td className="mono muted">{p.port || '—'}{p.container_port ? ` → ${p.container_port}` : ''}</td>
                          <td>
                            {p.last_deploy ? (
                              <div className="env-last">
                                <span>{fmtTime(p.last_deploy.at)}</span>
                                <span className="mono muted small" title={p.last_deploy.image_ref}>
                                  {p.last_deploy.image_ref || '—'}
                                </span>
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                          <td>
                            <div className="env-row-actions">
                              {p.method === 'helm' && (
                                <>
                                  <button
                                    className="btn ghost tiny"
                                    onClick={() => setDialog({ group: g, project: p, action: 'helm-history' })}
                                  >
                                    历史
                                  </button>
                                  <button
                                    className="btn ghost tiny"
                                    title={canMutate ? 'rolling restart 该 Helm 工作负载' : '打开弹窗；执行需要终审角色'}
                                    onClick={() => setDialog({ group: g, project: p, action: 'rollout-restart' })}
                                  >
                                    重启
                                  </button>
                                </>
                              )}
                              {p.method === 'ssh' && p.container && (
                                <>
                                  <button
                                    className="btn ghost tiny"
                                    onClick={() => setDialog({ group: g, project: p, action: 'docker-logs' })}
                                  >
                                    日志
                                  </button>
                                  <button
                                    className="btn ghost tiny"
                                    title={canMutate ? '重启该 Docker 容器' : '打开弹窗；执行需要终审角色'}
                                    onClick={() => setDialog({ group: g, project: p, action: 'docker-restart' })}
                                  >
                                    重启
                                  </button>
                                </>
                              )}
                              {!((p.method === 'helm') || (p.method === 'ssh' && p.container)) && (
                                <span className="muted small">—</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {snap && (snap.loading || snap.log || snap.error) && (
                  <div className="env-snapshot">
                    <div className="env-snapshot-head">
                      <strong>主机快照</strong>
                      {snap.error ? (
                        <span className="badge err">{snap.error}</span>
                      ) : (
                        <Badge status={snap.done ? (snap.exit === 0 ? 'success' : 'failed') : 'running'} />
                      )}
                      {snap.log && <span className="muted small">docker ps · k3s nodes/pods/svc/workloads · Helm 目标附 helm list</span>}
                    </div>
                    <pre className="env-log">{snap.log || (snap.error ? '' : '等待远端输出…')}</pre>
                  </div>
                )}

                {audit.length > 0 && (
                  <div className="env-audit">
                    <strong>最近操作</strong>
                    {audit.map((a) => (
                      <div className="env-audit-row" key={a.id}>
                        <span className="muted small">{fmtTime(a.created_at)}</span>
                        <span>{ENV_ACTION_LABEL[a.action] || a.action_label || a.action}</span>
                        <span className="muted small">{a.project_name || a.project_id} · {a.target || '—'}</span>
                        <span className="muted small">{a.actor || '—'}</span>
                        <Badge status={a.status} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      {dialog && (
        <EnvActionModal
          group={dialog.group}
          project={dialog.project}
          action={dialog.action}
          role={role}
          onClose={() => setDialog(null)}
          onDone={() => void refreshAudit(dialog.group.host)}
        />
      )}
    </div>
  )
}

// ---------- Agent / Text2SQL ----------

const AGENT_HISTORY_KEY = 'cicdkit_agent_history'

const AGENT_EXAMPLES = [
  '每个项目最近一次部署的状态和时间',
  '最近 20 条失败的运行，分别是什么项目',
  '最近 7 天有哪些项目部署过',
  '最近 30 天运行失败最多的 5 个项目',
  '当前探测异常的服务有哪些',
  '各部署方式的成功率和数量',
]

function readAgentHistory(): string[] {
  try {
    const raw = localStorage.getItem(AGENT_HISTORY_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.trim()).slice(0, 5) : []
  } catch {
    return []
  }
}

function writeAgentHistory(next: string[]) {
  try {
    localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify(next.slice(0, 5)))
  } catch {
    /* 隐私模式忽略 */
  }
}

const AGENT_COL_LABEL: Record<string, string> = {
  project_name: '项目',
  name: '项目',
  status: '状态',
  trigger: '触发',
  method: '方式',
  target: '目标',
  primary_target: '主目标',
  cluster: '集群',
  namespace: '命名空间',
  image_ref: '镜像',
  created_at: '时间',
  updated_at: '更新时间',
  duration_sec: '耗时',
  stage_summary: '阶段',
  probe_status: '探测',
  probe_url: '探测地址',
  branch: '分支',
  id: 'ID',
  project_id: '项目 ID',
  n: '数量',
  count: '数量',
}

function agentCell(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function fmtDurationSec(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n < 60) return `${Math.round(n)} 秒`
  const m = Math.floor(n / 60)
  const s = Math.round(n % 60)
  return s ? `${m} 分 ${s} 秒` : `${m} 分`
}

function agentValue(col: string, v: unknown) {
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>
  if ((col === 'status' || col === 'probe_status') && typeof v === 'string') {
    return <Badge status={v} />
  }
  if (col === 'created_at' || col === 'updated_at') {
    return <span className="mono small">{fmtTime(String(v))}</span>
  }
  if (col === 'duration_sec') return fmtDurationSec(v)
  const text = agentCell(v)
  if (text.length > 56) {
    return (
      <span className="agent-clip" title={text}>
        {text}
      </span>
    )
  }
  return text
}

function AgentPage({
  role,
  llmEnabled,
  onOpenLLM,
}: {
  role: string
  llmEnabled?: boolean
  onOpenLLM?: () => void
}) {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState<AgentResult | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [showSql, setShowSql] = useState(true)
  const [copied, setCopied] = useState(false)
  const [history, setHistory] = useState<string[]>(() => readAgentHistory())
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const ask = async (text?: string) => {
    const q = (text ?? question).trim()
    if (!q) return
    setQuestion(q)
    setLoading(true)
    setError('')
    setCopied(false)
    const started = performance.now()
    try {
      const res = await API.agentQuery(q, role)
      setResult(res)
      setElapsed((performance.now() - started) / 1000)
      setHistory((prev) => {
        const next = [q, ...prev.filter((x) => x !== q)].slice(0, 5)
        writeAgentHistory(next)
        return next
      })
    } catch (e: any) {
      setResult(null)
      setElapsed(0)
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }

  const clear = () => {
    setQuestion('')
    setResult(null)
    setError('')
    setElapsed(0)
    setCopied(false)
    inputRef.current?.focus()
  }

  const copySql = async () => {
    if (!result?.sql) return
    try {
      await navigator.clipboard.writeText(result.sql)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  const columns = result?.columns?.length
    ? result.columns
    : result && result.rows.length > 0
      ? Object.keys(result.rows[0])
      : []

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Agent · Text2SQL</h1>
          <p className="muted">
            用自然语言查项目 / 运行 / 部署。模型只生成一条受限 SELECT，后端校验后执行，不写库、不触发发布
          </p>
        </div>
        <div className="row wrap">
          {llmEnabled === true ? (
            <span className="chip">LLM 已就绪</span>
          ) : llmEnabled === false ? (
            <span className="chip warn">LLM 未配置</span>
          ) : (
            <span className="chip">LLM 检测中</span>
          )}
          <span className="chip">只读</span>
        </div>
      </div>

      {llmEnabled === false && (
        <div className="notice warn agent-llm-warn">
          <div>
            <strong>LLM 还没启用</strong>
            <p className="small" style={{ margin: '2px 0 0' }}>
              查询需要先配置模型接口，否则只能看到校验失败提示。
            </p>
          </div>
          {onOpenLLM && (
            <button className="btn" onClick={onOpenLLM}>
              去设置
            </button>
          )}
        </div>
      )}

      <section className="panel agent-composer">
        <div className="agent-composer-body">
          <div className="agent-avatar" aria-hidden="true">
            AI
          </div>
          <div className="agent-composer-main">
            <textarea
              ref={inputRef}
              className="input agent-input"
              placeholder="例如：最近 7 天有哪些项目部署过？"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  ask()
                }
              }}
            />
            <div className="agent-actions">
              <span className="muted small">⌘/Ctrl + Enter 提交 · 每分钟最多 5 次 · 仅生成 SELECT</span>
              <div className="row">
                {(question || result || error) && (
                  <button className="btn ghost" onClick={clear} disabled={loading}>
                    清空
                  </button>
                )}
                <button className="btn primary" onClick={() => ask()} disabled={loading || !question.trim()}>
                  {loading ? (
                    <>
                      <span className="spin" /> 生成中…
                    </>
                  ) : (
                    '查询'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="agent-suggest">
          <div className="agent-suggest-head">
            <span className="small">示例问题</span>
            <span className="muted small">点击直接查询</span>
          </div>
          <div className="agent-example-grid">
            {AGENT_EXAMPLES.map((x) => (
              <button key={x} className="agent-example" onClick={() => ask(x)} disabled={loading}>
                <span>{x}</span>
                <span className="agent-example-arrow" aria-hidden="true">
                  →
                </span>
              </button>
            ))}
          </div>
          {history.length > 0 && (
            <div className="agent-history">
              <span className="muted small">历史</span>
              {history.map((x) => (
                <button key={x} className="chip" onClick={() => ask(x)} disabled={loading} title={x}>
                  {x.length > 28 ? x.slice(0, 28) + '…' : x}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {error && <ErrorBox error={error} onRetry={() => ask()} />}

      {loading && (
        <section className="panel agent-loading">
          <div className="agent-loading-head">
            <span className="spin" />
            <div>
              <strong>正在生成 SQL 并执行</strong>
              <p className="muted small">模型响应可能需要 10–90 秒，请稍候，不需要刷新页面</p>
            </div>
          </div>
          <div className="agent-skeleton" />
          <div className="agent-skeleton short" />
          <div className="agent-skeleton" />
        </section>
      )}

      {!loading && result && (
        <section className="panel agent-result">
          <div className="panel-head">
            <div className="row">
              <h2>查询结果</h2>
              <span className="chip">{result.count} 行</span>
            </div>
            <span className="muted small">
              {elapsed > 0 ? `耗时 ${elapsed.toFixed(1)} 秒 · ` : ''}
              {result.read_only === false ? '非只读' : '只读'}
            </span>
          </div>
          <div className="agent-result-body">
            <p className="agent-question-line">
              <span className="muted">问题</span>
              {result.question || question}
            </p>
            {result.summary ? (
              <div className="agent-summary">
                <span className="agent-summary-label">AI 总结</span>
                <p>{result.summary}</p>
              </div>
            ) : result.explain ? (
              <p className="muted small agent-explain">{result.explain}</p>
            ) : null}

            <div className="agent-sql">
              <div className="agent-sql-head">
                <span className="mono small">GENERATED SQL</span>
                <div className="row">
                  <button className="btn ghost tiny" onClick={copySql}>
                    {copied ? '已复制' : '复制'}
                  </button>
                  <button className="btn ghost tiny" onClick={() => setShowSql((v) => !v)}>
                    {showSql ? '收起' : '展开'}
                  </button>
                </div>
              </div>
              {showSql && <pre className="mono small">{result.sql}</pre>}
            </div>

            {result.rows.length === 0 || columns.length === 0 ? (
              <div className="empty">查询完成，没有匹配的数据</div>
            ) : (
              <div className="agent-table-wrap">
                <table className="table agent-table">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c}>{AGENT_COL_LABEL[c] || c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i}>
                        {columns.map((c) => (
                          <td key={c} className={c === 'id' || c === 'project_id' ? 'mono small' : ''}>
                            {agentValue(c, row[c])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {!result && !error && !loading && (
        <div className="agent-guard">
          <div>
            <strong>只读执行</strong>
            <span>仅允许三张 agent_* 表的单条 SELECT，禁 JOIN / 子查询 / 写操作。</span>
          </div>
          <div>
            <strong>结果可核对</strong>
            <span>每次查询都返回生成 SQL，可展开、复制，再自行验证口径。</span>
          </div>
          <div>
            <strong>受控调用</strong>
            <span>全局每分钟最多 5 次；数据窗口为最近 500 项目 / 300 运行 / 300 部署。</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------- 授权判定审计 ----------

function exportAudit(rows: unknown[], prefix: string) {
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `cicdkit-${prefix}-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function localEpoch(value: string): number | undefined {
  if (!value) return undefined
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

function AuditPage() {
  const [kind, setKind] = useState<'access' | 'env'>('access')
  const [events, setEvents] = useState<AccessEvent[]>([])
  const [envActions, setEnvActions] = useState<EnvironmentAction[]>([])
  const [user, setUser] = useState('')
  const [resource, setResource] = useState('')
  const [host, setHost] = useState('')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const from = localEpoch(since)
      const to = localEpoch(until)
      if (from && to && from > to) throw new Error('开始时间不能晚于结束时间')
      if (kind === 'access') {
        const res = await API.auditAccess({
          user: user.trim() || undefined,
          resource: resource.trim() || undefined,
          since: from,
          until: to,
          limit: 100,
        })
        setEvents(res.events || [])
      } else {
        const res = await API.listEnvironmentActions(host.trim() || undefined, 100, from, to)
        setEnvActions(res.actions || [])
      }
      setError('')
    } catch (e: any) {
      setError(e.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [kind, user, resource, host, since, until])

  useEffect(() => {
    load()
  }, [load])

  const rows = kind === 'access' ? events : envActions
  const current = kind === 'access' ? events : envActions

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>审计</h1>
          <p className="muted">
            {kind === 'access'
              ? '每次资源/动作授权判定都留痕：谁、什么角色、放行还是拒绝'
              : '云环境受控动作的执行审计：主机、目标、动作和最终状态'}
          </p>
        </div>
        <div className="row">
          {kind === 'access' ? (
            <>
              <input
                className="input"
                placeholder="按用户过滤…"
                value={user}
                onChange={(e) => setUser(e.target.value)}
              />
              <input
                className="input"
                placeholder="按资源过滤…"
                value={resource}
                onChange={(e) => setResource(e.target.value)}
              />
            </>
          ) : (
            <input
              className="input"
              placeholder="按主机过滤…"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          )}
          <button className="btn" onClick={load} disabled={loading}>
            刷新
          </button>
          <button className="btn ghost" onClick={() => exportAudit(rows, kind)} disabled={current.length === 0}>
            导出
          </button>
        </div>
      </div>

      <div className="row wrap" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="row">
          <button className={kind === 'access' ? 'btn' : 'btn ghost'} onClick={() => setKind('access')}>
            授权判定
          </button>
          <button className={kind === 'env' ? 'btn' : 'btn ghost'} onClick={() => setKind('env')}>
            云环境动作
          </button>
        </div>
        <div className="row wrap">
          <span className="muted small">时间范围</span>
          <input
            className="input"
            type="datetime-local"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="开始时间"
          />
          <span className="muted small">至</span>
          <input
            className="input"
            type="datetime-local"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            aria-label="结束时间"
          />
          {(since || until) && (
            <button
              className="btn ghost"
              onClick={() => {
                setSince('')
                setUntil('')
              }}
            >
              清除时间
            </button>
          )}
        </div>
      </div>

      {error && <ErrorBox error={error} onRetry={load} />}

      {loading && current.length === 0 ? (
        <Spinner label={kind === 'access' ? '正在读取审计记录…' : '正在读取云环境动作…'} />
      ) : current.length === 0 ? (
        <div className="empty">
          {kind === 'access'
            ? '还没有授权记录。触发一次写操作或拒绝后，这里会出现。'
            : '还没有云环境动作。到「云环境」页执行一次 helm-history 或重启后，这里会出现。'}
        </div>
      ) : (
        <>
          <p className="muted small">最近 {current.length} 条，按时间倒序</p>
          {kind === 'access' ? (
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>用户</th>
                  <th>角色</th>
                  <th>资源</th>
                  <th>动作</th>
                  <th>判定</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={e.id || `audit-${i}`}>
                    <td className="muted small">{fmtTime(e.created_at)}</td>
                    <td>{e.user || '—'}</td>
                    <td className="muted">{ROLE_LABEL[e.role || ''] || e.role || '—'}</td>
                    <td className="mono small">{e.resource || '—'}</td>
                    <td className="mono small">{e.action || '—'}</td>
                    <td>
                      <span className={e.allowed ? 'badge ok' : 'badge err'}>
                        {e.allowed ? '放行' : '拒绝'}
                      </span>
                    </td>
                    <td className="muted small" title={e.reason || ''}>
                      {e.allowed ? e.label || '—' : e.reason || e.label || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>主机</th>
                  <th>项目 / 目标</th>
                  <th>动作</th>
                  <th>状态</th>
                  <th>操作者</th>
                  <th>job</th>
                </tr>
              </thead>
              <tbody>
                {envActions.map((e, i) => (
                  <tr key={e.id || `env-audit-${i}`}>
                    <td className="muted small">{fmtTime(e.created_at)}</td>
                    <td className="mono small">{e.host || '—'}</td>
                    <td className="muted small">
                      {e.project_name || e.project_id || '—'} / {e.target || '—'}
                    </td>
                    <td className="mono small">{e.action_label || e.action || '—'}</td>
                    <td>
                      <Badge status={e.status} />
                    </td>
                    <td>{e.actor || '—'}</td>
                    <td className="mono small" title={e.error || ''}>
                      {e.job_id || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}

// ---------- 知识库 ----------

// 只读列表 + 删除：BFF 透传上游 /api/kb。新增条目只能通过运行页的「采纳」，
// 所以这里不提供手工新建/编辑，避免前端自己拼一条没有 signature 的记录。
function KBPage({ role }: { role: string }) {
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
      await API.removeKb(entry.id, role)
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
  const [rolePass, setRolePass] = useState<string>(readRolePass())
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

  const changePass = (next: string) => {
    setRolePass(next)
    writeRolePass(next)
  }

  // 默认角色（CICD_DEFAULT_ROLE）只在第一次见到时套用：单人用 cicd 账号登录时
  // 不必每次手动把顶栏从「操作员」切到「终审」；之后用户自己切换仍会被记住。
  useEffect(() => {
    const def = meta?.approval.default_role
    if (!def || !Object.keys(ROLE_LABEL).includes(def)) return
    try {
      if (localStorage.getItem(ROLE_DEFAULT_MARK) === def) return
      changeRole(def)
      localStorage.setItem(ROLE_DEFAULT_MARK, def)
    } catch {
      /* 隐私模式：不记忆，但本次仍切过去 */
      changeRole(def)
    }
  }, [meta])

  const approvalMode = meta?.approval.mode || 'off'
  const identityBound = meta?.approval.auth === 'identity'
  const roleOptions = identityBound ? meta?.approval.roles || [] : Object.keys(ROLE_LABEL)

  // 身份绑定后，顶栏只能选该账号被授予的角色；localStorage 里的旧角色
  // 如果不在授予列表里，自动落到第一个可用角色。
  useEffect(() => {
    if (!identityBound) return
    // 身份模式不需要角色口令；清掉旧模式可能留下的明文，避免继续跟着 URL 走。
    setRolePass('')
    writeRolePass('')
    if (roleOptions.length === 0) return
    if (!roleOptions.includes(role)) changeRole(roleOptions[0])
  }, [identityBound, roleOptions.join(','), role])

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => navigate('overview')}>
          <span className="logo">◆</span>
          <div>
            <strong>CICDKit</strong>
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
            <select
              className="input small"
              value={role}
              onChange={(e) => changeRole(e.target.value)}
              title={identityBound ? `Basic Auth 用户 ${meta?.approval.user || ''} 被授予的角色` : ''}
            >
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r] || r}
                </option>
              ))}
            </select>
          </label>

          {!identityBound && (
            <label className="role" title="控制面配了 CICD_ROLE_MAP 时，角色由口令反查（?pass=）；没配就留空">
              <span className="muted small">口令</span>
              <input
                className="input small"
                style={{ width: 104 }}
                placeholder="可选"
                value={rolePass}
                onChange={(e) => changePass(e.target.value)}
              />
            </label>
          )}

          <span className={approvalMode === 'off' ? 'chip' : 'chip warn'} title="发布审批闸门（CICD_DEPLOY_APPROVAL）">
            闸门 {approvalMode}
          </span>
          {meta?.approval.auth === 'role-map' && (
            <span className="chip" title="CICD_ROLE_MAP 已启用：角色只能由口令反查">
              口令绑定
            </span>
          )}
          {identityBound && (
            <span
              className={meta?.approval.identity_ok ? 'chip' : 'chip warn'}
              title={meta?.approval.identity_reason || '角色来自 Basic Auth 用户的账号表'}
            >
              {meta?.approval.identity_ok ? `身份 ${meta?.approval.user}` : '身份未绑定'}
            </span>
          )}

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
            {health ? (health.ok ? '执行器在线' : '执行器离线') : '检测中…'}
          </span>
        </div>
      </header>

      <main>
        {route === 'overview' && <OverviewPage role={role} />}
        {route === 'projects' && <ProjectsPage role={role} />}
        {route === 'runs' && <RunsPage role={role} />}
        {route === 'deployments' && <DeploymentsPage role={role} />}
        {route === 'environments' && <EnvironmentsPage role={role} />}
        {route === 'agent' && (
          <AgentPage role={role} llmEnabled={meta?.llm?.enabled} onOpenLLM={() => setShowLLM(true)} />
        )}
        {route === 'kb' && <KBPage role={role} />}
        {route === 'audit' && <AuditPage />}
      </main>

      {showLLM && (
        <LLMSettings role={role} onClose={() => setShowLLM(false)} onSaved={loadMeta} />
      )}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
