// cicd-runner —— 无 UI 的薄执行器
//
// 它只做一件事：按 job spec 跑一串 argv，把 stdout/stderr 流式写进日志文件，
// 并把状态暴露给控制面轮询。**它不做任何业务判断** —— 构建参数、发布方式、
// 用哪个 kubeconfig，全部由 Lume 控制面（src/exec.lume）拼好后传进来。
//
// 这么切分的理由：
//   - Lume 所在的公开进程只监听 18107，握不到 docker socket / ssh 私钥；
//     真要有命令执行能力的是这个内网进程，端口不对外发布。
//   - Lume DSL 侧没有 spawn（本仓按 P14 决策永久不合并），但拼命令行只是字符串
//     与 map 的活，恰好是 DSL 擅长的部分；"跑起来" 才是它做不了的。
//
// 安全边界（三道，缺一不可）：
//  1. 只监听 RUNNER_BIND（默认 127.0.0.1:8899）；容器里由 compose 的 networks
//     限制在内网，不映射宿主端口。
//  2. 每个请求要带 X-Runner-Token（RUNNER_AUTH_FILE 或 RUNNER_AUTH），
//     常量时间比较。
//  3. argv[0] 的 basename 必须在 RUNNER_ALLOW 白名单里（默认
//     docker,kubectl,ssh,helm,git）—— 即使 token 泄漏，也拿不到任意命令执行。
//     不解释 shell：argv 直接 exec，不经过 sh -c。
//
// 环境变量：
//
//	RUNNER_BIND        默认 127.0.0.1:8899
//	RUNNER_LOG_DIR     日志目录，默认 ./logs（需与控制面共享，控制面按字节偏移读）
//	RUNNER_ALLOW       允许的二进制，逗号分隔
//	RUNNER_MAX_JOBS    并发任务上限，默认 4
//	RUNNER_AUTH_FILE   从文件读 token（优先）
//	RUNNER_AUTH        直接给 token
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------- 数据模型 ----------

// Step 是 job 里的一步：直接 exec argv，不经过 shell。
type Step struct {
	Argv    []string          `json:"argv"`
	Env     map[string]string `json:"env"`
	Cwd     string            `json:"cwd"`
	Timeout int               `json:"timeout_s"` // 单步超时；0 = 不设
	Label   string            `json:"label"`
	// Stdin 是需要喂给进程的输入。镜像仓库口令走 `docker login --password-stdin`，
	// 用 stdin 传就不会出现在 argv 里（也就不会进日志与 ps 输出）。
	Stdin string `json:"stdin"`
}

type StepState struct {
	Label   string   `json:"label"`
	Argv    []string `json:"argv"`
	Status  string   `json:"status"` // pending|running|done|failed|canceled
	Exit    int      `json:"exit"`
	Started string   `json:"started,omitempty"`
	Ended   string   `json:"ended,omitempty"`
}

type Job struct {
	ID        string      `json:"id"`
	Name      string      `json:"name"`
	Status    string      `json:"status"`
	Exit      int         `json:"exit"`
	Steps     []StepState `json:"steps"`
	LogLen    int64       `json:"log_len"`
	CreatedAt string      `json:"created_at"`
	StartedAt string      `json:"started_at"`
	EndedAt   string      `json:"ended_at"`
	Error     string      `json:"error,omitempty"`

	Canceled bool `json:"canceled"`

	logPath string
	steps   []Step
	cancel  context.CancelFunc
	mu      sync.Mutex
}

type server struct {
	allow  map[string]bool
	logDir string
	token  string
	mu     sync.Mutex
	jobs   map[string]*Job
	order  []string
	sem    chan struct{}
}

// ---------- 入口 ----------

func main() {
	bind := envOr("RUNNER_BIND", "127.0.0.1:8899")
	logDir := envOr("RUNNER_LOG_DIR", "./logs")
	allow := envOr("RUNNER_ALLOW", "docker,kubectl,ssh,helm,git,scp,sudo")
	maxJobs, _ := strconv.Atoi(envOr("RUNNER_MAX_JOBS", "4"))
	if maxJobs <= 0 {
		maxJobs = 1
	}

	token := strings.TrimSpace(os.Getenv("RUNNER_AUTH"))
	if f := strings.TrimSpace(os.Getenv("RUNNER_AUTH_FILE")); f != "" {
		if b, err := os.ReadFile(f); err == nil {
			token = strings.TrimSpace(string(b))
		} else if token == "" {
			log.Printf("warn: RUNNER_AUTH_FILE unreadable: %v", err)
		}
	}
	if token == "" {
		log.Printf("warn: no token configured — the runner is reachable without auth on %s", bind)
	}

	if err := os.MkdirAll(logDir, 0o700); err != nil {
		log.Fatalf("cannot create log dir %s: %v", logDir, err)
	}

	s := &server{
		allow:  map[string]bool{},
		logDir: logDir,
		token:  token,
		jobs:   map[string]*Job{},
		sem:    make(chan struct{}, maxJobs),
	}
	for _, b := range strings.Split(allow, ",") {
		if v := strings.TrimSpace(b); v != "" {
			s.allow[v] = true
		}
	}
	log.Printf("cicd-runner on %s, log dir %s, allowed: %s, max jobs %d",
		bind, logDir, strings.Join(keysOf(s.allow), ","), maxJobs)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.auth(s.handleHealth))
	mux.HandleFunc("/jobs", s.auth(s.handleJobs))
	mux.HandleFunc("/jobs/", s.auth(s.handleJob))
	if err := http.ListenAndServe(bind, mux); err != nil {
		log.Fatalf("listen %s: %v", bind, err)
	}
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---------- 鉴权 ----------

func (s *server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.token != "" {
			got := r.Header.Get("X-Runner-Token")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) != 1 {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "runner token 不匹配"})
				return
			}
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	n := len(s.jobs)
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "cicd-runner", "jobs": n})
}

// ---------- 提交 ----------

type submitReq struct {
	Name    string `json:"name"`
	Steps   []Step `json:"steps"`
	Timeout int    `json:"timeout_s"`
	WorkDir string `json:"work_dir"`
}

func (s *server) handleJobs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只接受 POST /jobs"})
		return
	}
	var req submitReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体解析失败: " + err.Error()})
		return
	}
	if len(req.Steps) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "steps 不能为空"})
		return
	}
	for i, st := range req.Steps {
		if len(st.Argv) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fmt.Sprintf("第 %d 步 argv 为空", i+1)})
			return
		}
		bin := filepath.Base(st.Argv[0])
		if !s.allow[bin] {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"ok": false,
				"error": fmt.Sprintf("第 %d 步的可执行文件 %q 不在白名单（允许: %s）",
					i+1, bin, strings.Join(keysOf(s.allow), ",")),
			})
			return
		}
		if st.Cwd != "" && !filepath.IsAbs(st.Cwd) {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": fmt.Sprintf("第 %d 步 cwd 必须是绝对路径: %q", i+1, st.Cwd)})
			return
		}
	}

	name := sanitize(req.Name)
	if name == "" {
		name = "job-" + time.Now().Format("20060102-150405")
	}

	id := "job-" + randHex(8)
	job := &Job{
		ID:        id,
		Name:      name,
		Status:    "queued",
		Exit:      -1,
		CreatedAt: nowISO(),
		steps:     req.Steps,
		logPath:   filepath.Join(s.logDir, name+".log"),
	}
	for _, st := range req.Steps {
		job.Steps = append(job.Steps, StepState{
			Label: st.Label, Argv: st.Argv, Status: "pending", Exit: -1,
		})
	}

	// 日志文件先截断：控制面按 <name>.log 的字节偏移轮询，同名重跑必须从 0 开始。
	if err := os.WriteFile(job.logPath, []byte{}, 0o600); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "无法创建日志文件: " + err.Error()})
		return
	}

	s.mu.Lock()
	s.jobs[id] = job
	s.order = append(s.order, id)
	s.prune()
	s.mu.Unlock()

	go s.run(job, req.Timeout)

	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "id": id, "log": job.logPath})
}

// prune 只保留最近 200 个已结束的任务，避免长跑进程内存只涨不跌。
func (s *server) prune() {
	if len(s.order) <= 200 {
		return
	}
	for _, id := range s.order[:len(s.order)-200] {
		if j, ok := s.jobs[id]; ok && j.Status != "running" && j.Status != "queued" {
			delete(s.jobs, id)
		}
	}
	s.order = s.order[len(s.order)-200:]
}

func sanitize(name string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return ""
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9',
			r == '-', r == '_', r == '.':
			b.WriteRune(r)
		}
	}
	out := b.String()
	if len(out) > 120 {
		out = out[:120]
	}
	return out
}

func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(b)
}

func nowISO() string { return time.Now().Format(time.RFC3339) }

// ---------- 执行 ----------

func (s *server) run(job *Job, timeoutS int) {
	s.sem <- struct{}{}
	defer func() { <-s.sem }()

	ctx, cancel := context.WithCancel(context.Background())
	job.mu.Lock()
	job.cancel = cancel
	job.Status = "running"
	job.StartedAt = nowISO()
	job.mu.Unlock()
	defer cancel()

	f, err := os.OpenFile(job.logPath, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		job.mu.Lock()
		job.Status = "failed"
		job.Error = "无法打开日志文件: " + err.Error()
		job.EndedAt = nowISO()
		job.mu.Unlock()
		return
	}
	defer f.Close()

	if timeoutS > 0 {
		var stop context.CancelFunc
		ctx, stop = context.WithTimeout(ctx, time.Duration(timeoutS)*time.Second)
		defer stop()
	}

	exit := 0
	for i := range job.steps {
		step := job.steps[i]
		if ctx.Err() != nil {
			job.setStep(i, "canceled", -1, "")
			exit = 130
			break
		}
		job.setStep(i, "running", -1, nowISO())
		fmt.Fprintf(f, "\n$ %s\n", joinArgv(step.Argv))

		stepCtx := ctx
		stopStep := func() {}
		if step.Timeout > 0 {
			var stop context.CancelFunc
			stepCtx, stop = context.WithTimeout(ctx, time.Duration(step.Timeout)*time.Second)
			stopStep = stop
		}
		code, runErr := execStep(stepCtx, step, f)
		// 取消有两种来源：整 job 的 cancel 端点和单步超时。两种都必须走 canceled，
		// 不能落成 failed —— 否则前端会把「人工取消」当成一次失败构建，
		// 还会触发 AI 诊断。
		canceled := stepCtx.Err() != nil
		stopStep()
		job.mu.Lock()
		job.LogLen = fileSize(job.logPath)
		job.mu.Unlock()

		if canceled {
			job.setStep(i, "canceled", code, nowISO())
			fmt.Fprintf(f, "\n[step %d canceled: %v]\n", i+1, stepCtx.Err())
			job.mu.Lock()
			job.Canceled = true
			job.mu.Unlock()
			exit = 130
			break
		}
		if runErr != nil || code != 0 {
			job.setStep(i, "failed", code, nowISO())
			exit = code
			if exit == 0 {
				exit = 1
			}
			fmt.Fprintf(f, "\n[step %d failed: exit=%d err=%v]\n", i+1, code, runErr)
			break
		}
		job.setStep(i, "done", 0, nowISO())
	}

	job.mu.Lock()
	job.Exit = exit
	job.LogLen = fileSize(job.logPath)
	job.EndedAt = nowISO()
	switch {
	case job.Canceled || exit == 130:
		job.Status = "canceled"
		job.Exit = 130
	case exit != 0:
		job.Status = "failed"
	default:
		job.Status = "done"
	}
	for i := range job.Steps {
		if job.Steps[i].Status == "pending" {
			job.Steps[i].Status = "skipped"
		}
	}
	job.mu.Unlock()
}

// execStep 直接 exec（不经 shell），stdout/stderr 逐行写入日志文件：
// 控制面每 1.5s 按字节偏移拉新增部分，所以必须「写一条就落盘」，不能缓冲。
func execStep(ctx context.Context, step Step, f *os.File) (int, error) {
	cmd := exec.CommandContext(ctx, step.Argv[0], step.Argv[1:]...)
	if step.Cwd != "" {
		cmd.Dir = step.Cwd
	}
	cmd.Env = os.Environ()
	for k, v := range step.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	if step.Stdin != "" {
		cmd.Stdin = strings.NewReader(step.Stdin)
	}
	cmd.Stdout = f
	cmd.Stderr = f
	cmd.WaitDelay = 5 * time.Second
	err := cmd.Run()
	if err == nil {
		return 0, nil
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	return -1, err
}

// joinArgv 把 argv 拼成可复制的命令行：含空格/空串/引号的参数加单引号。
func joinArgv(argv []string) string {
	parts := make([]string, 0, len(argv))
	for _, a := range argv {
		if a == "" || strings.ContainsAny(a, " \t\"'\\$`*?()[]{}|&;<>") {
			parts = append(parts, "'"+strings.ReplaceAll(a, "'", "'\\''")+"'")
		} else {
			parts = append(parts, a)
		}
	}
	return strings.Join(parts, " ")
}

func fileSize(path string) int64 {
	if fi, err := os.Stat(path); err == nil {
		return fi.Size()
	}
	return 0
}

// snapshot 在锁内取一份可编码的副本（Job 里有 mutex，不能整体复制）。
func (j *Job) snapshot() map[string]any {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.LogLen = fileSize(j.logPath)
	return map[string]any{
		"id":         j.ID,
		"name":       j.Name,
		"status":     j.Status,
		"exit":       j.Exit,
		"steps":      append([]StepState(nil), j.Steps...),
		"log_len":    j.LogLen,
		"created_at": j.CreatedAt,
		"started_at": j.StartedAt,
		"ended_at":   j.EndedAt,
		"canceled":   j.Canceled,
		"error":      j.Error,
	}
}

func (j *Job) setStep(i int, status string, exit int, ended string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if i < 0 || i >= len(j.Steps) {
		return
	}
	j.Steps[i].Status = status
	j.Steps[i].Exit = exit
	if ended != "" {
		j.Steps[i].Ended = ended
	}
}

// ---------- 查询 / 日志 / 取消 ----------

func (s *server) handleJob(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/jobs/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	id := parts[0]
	if id == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "缺少 job id"})
		return
	}

	s.mu.Lock()
	job, ok := s.jobs[id]
	s.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "job 不存在: " + id})
		return
	}

	if len(parts) > 1 {
		switch parts[1] {
		case "log":
			s.handleLog(w, r, job)
			return
		case "cancel":
			if r.Method != http.MethodPost {
				writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只接受 POST .../cancel"})
				return
			}
			job.mu.Lock()
			if job.cancel != nil && (job.Status == "running" || job.Status == "queued") {
				job.cancel()
			}
			job.mu.Unlock()
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": job.ID, "status": "canceled"})
			return
		}
	}

	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只接受 GET"})
		return
	}

	writeJSON(w, http.StatusOK, job.snapshot())
}

// handleLog 按字节偏移给增量日志。from=0 表示「取尾部最多 max 字节」。
func (s *server) handleLog(w http.ResponseWriter, r *http.Request, job *Job) {
	job.mu.Lock()
	path := job.logPath
	job.mu.Unlock()

	from, _ := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	maxBytes, _ := strconv.ParseInt(r.URL.Query().Get("max"), 10, 64)
	if maxBytes <= 0 {
		maxBytes = 262144
	}

	f, err := os.Open(path)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"log": "", "log_len": 0, "from": 0, "reset": from > 0})
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	total := fi.Size()
	reset := false
	if from <= 0 || from > total {
		if total > maxBytes {
			from = total - maxBytes
		} else {
			from = 0
		}
		reset = true
	}
	if _, err := f.Seek(from, 0); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	buf := make([]byte, total-from)
	if _, err := f.Read(buf); err != nil && !errors.Is(err, io.EOF) {
		// 读多少算多少：尾部被并发追加属于正常情况
	}
	// 从 UTF-8 字符边界开始，避免前端 JSON 串里出现半个汉字。
	for i := 0; i < len(buf) && !utf8Start(buf[i]); i++ {
		buf = buf[1:]
		from++
	}

	job.mu.Lock()
	status := job.Status
	job.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"log":     string(buf),
		"log_len": total,
		"from":    from,
		"status":  status,
		"reset":   reset,
	})
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
