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
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
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
	// StartedTS / EndedTS 是 unix 秒（整秒），给控制面算 /metrics 直方图用：
	// ISO 字符串在 Lume DSL 里没法解析成时长，数值可以直接相减。
	StartedTS int64 `json:"started_ts,omitempty"`
	EndedTS   int64 `json:"ended_ts,omitempty"`
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

type cappedWriter struct {
	f        *os.File
	left     int64
	limit    int64
	clipOnce bool
	mu       sync.Mutex
}

// 日志封顶：docker build / npm 这类输出能轻易上百 MB，而控制面的 read_file
// 超过 16 MiB 会直接抛错（不是截断），接口就变成 500、前端一片空白。
// 所以在这里就把文件按住：超限后停止写入并落一行标记，绝不返回 error ——
// 日志写不下不该让构建失败。
func newCappedWriter(f *os.File, limit int64) *cappedWriter {
	return &cappedWriter{f: f, left: limit, limit: limit}
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.left <= 0 {
		if !w.clipOnce {
			w.clipOnce = true
			fmt.Fprintf(w.f, "\n[log capped at %d bytes; see the runner host for the full output]\n", w.limit)
		}
		return len(p), nil
	}
	if int64(len(p)) > w.left {
		n, err := w.f.Write(p[:w.left])
		w.left = 0
		if err != nil {
			return n, err
		}
		w.clipOnce = true
		fmt.Fprintf(w.f, "\n[log capped at %d bytes; see the runner host for the full output]\n", w.limit)
		return len(p), nil
	}
	n, err := w.f.Write(p)
	w.left -= int64(n)
	return n, err
}

type server struct {
	allow  map[string]bool
	logDir string
	token  string
	mu     sync.Mutex
	jobs   map[string]*Job
	order  []string
	sem    chan struct{}
	logMax int64
}

// ---------- 入口 ----------

func main() {
	bind := envOr("RUNNER_BIND", "127.0.0.1:8899")
	logDir := envOr("RUNNER_LOG_DIR", "./logs")
	allow := envOr("RUNNER_ALLOW", "docker,kubectl,ssh,helm,git,scp")
	// 默认 16 MiB - 8 KiB：控制面的 read_file 上限是 16 MiB，留出写封顶标记的余量。
	logMaxBytes, _ := strconv.ParseInt(envOr("RUNNER_LOG_MAX_BYTES", "16769024"), 10, 64)
	if logMaxBytes <= 0 {
		logMaxBytes = 16769024
	}
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
		logMax: logMaxBytes,
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
	mux.HandleFunc("/fs/list", s.auth(s.handleFsList))

	srv := &http.Server{
		Addr:              bind,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// 容器 stop 时先取消在跑的 job（exec.CommandContext 会杀掉子进程），
	// 再给在途请求 10s 收尾；否则 docker stop 要等到 SIGKILL 才退出。
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		log.Printf("shutdown: canceling jobs")
		s.cancelAll()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("listen %s: %v", bind, err)
	}
}

func (s *server) cancelAll() {
	s.mu.Lock()
	jobs := make([]*Job, 0, len(s.jobs))
	for _, j := range s.jobs {
		jobs = append(jobs, j)
	}
	s.mu.Unlock()
	for _, j := range jobs {
		j.mu.Lock()
		c := j.cancel
		j.mu.Unlock()
		if c != nil {
			c()
		}
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
	// 一次提交的 argv/env 不该超过几 MB；上限挡住超大 JSON 把内存吃满。
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
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
// 运行中/排队中的任务一律保留在 order 里：第一版直接切 order 尾部，
// 把还在跑的任务 id 从 order 里切掉了 —— map 里留着、order 里没了，
// 之后再也轮不到它被清理，等于反向泄漏。调用方持有 s.mu。
func (s *server) prune() {
	if len(s.order) <= 200 {
		return
	}
	cut := len(s.order) - 200
	keep := make([]string, 0, 200+cut)
	live := 0
	for i, id := range s.order {
		j, ok := s.jobs[id]
		if !ok {
			continue
		}
		if i < cut {
			if j.Status == "running" || j.Status == "queued" {
				keep = append(keep, id)
				live++
				continue
			}
			delete(s.jobs, id)
			continue
		}
		keep = append(keep, id)
	}
	s.order = keep
	if live > 0 {
		log.Printf("prune: 保留 %d 个仍在运行的任务", live)
	}
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
	// ctx 必须在等信号量之前就建好并挂到 job 上：排队中的任务也要能被取消，
	// 否则 cancel 端点找不到 cancel 函数，只能返回一个「已取消」的假象。
	ctx, cancel := context.WithCancel(context.Background())
	job.mu.Lock()
	job.cancel = cancel
	job.mu.Unlock()
	defer cancel()

	select {
	case s.sem <- struct{}{}:
	case <-ctx.Done():
		s.finish(job, 130)
		return
	}
	defer func() { <-s.sem }()

	job.mu.Lock()
	if job.Status == "canceled" {
		// 排队期间被取消：一步都不执行。
		job.mu.Unlock()
		s.finish(job, 130)
		return
	}
	job.Status = "running"
	job.StartedAt = nowISO()
	job.mu.Unlock()

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
	out := newCappedWriter(f, s.logMax)

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
		fmt.Fprintf(out, "\n$ %s\n", joinArgv(step.Argv))

		stepCtx := ctx
		stopStep := func() {}
		if step.Timeout > 0 {
			var stop context.CancelFunc
			stepCtx, stop = context.WithTimeout(ctx, time.Duration(step.Timeout)*time.Second)
			stopStep = stop
		}
		code, runErr := execStep(stepCtx, step, out)
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
			fmt.Fprintf(out, "\n[step %d canceled: %v]\n", i+1, stepCtx.Err())
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
			fmt.Fprintf(out, "\n[step %d failed: exit=%d err=%v]\n", i+1, code, runErr)
			break
		}
		job.setStep(i, "done", 0, nowISO())
	}

	s.finish(job, exit)
}

// finish 把任务推到终态：取消、失败、成功三种收口都走这里，
// 避免「排队取消」和「执行完」两套收尾逻辑慢慢跑偏。
func (s *server) finish(job *Job, exit int) {
	job.mu.Lock()
	defer job.mu.Unlock()
	job.Exit = exit
	job.LogLen = fileSize(job.logPath)
	if job.EndedAt == "" {
		job.EndedAt = nowISO()
	}
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
}

// execStep 直接 exec（不经 shell），stdout/stderr 逐行写入日志文件：
// 控制面每 1.5s 按字节偏移拉新增部分，所以必须「写一条就落盘」，不能缓冲。
func execStep(ctx context.Context, step Step, out io.Writer) (int, error) {
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
	cmd.Stdout = out
	cmd.Stderr = out
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
	now := time.Now().Unix()
	if status == "running" {
		j.Steps[i].StartedTS = now
	} else if j.Steps[i].StartedTS != 0 {
		j.Steps[i].EndedTS = now
	}
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
			// 两种情况都要覆盖：
			//   running —— 有 ctx，cancel() 终止进程；
			//   queued  —— 还在等信号量（cancel 字段可能是 nil），直接改状态，
			//              由 run() 在拿到槽位后看到 canceled 并跳过执行。
			if job.Status == "queued" {
				job.Status = "canceled"
				job.Canceled = true
				job.EndedAt = nowISO()
			}
			if job.cancel != nil {
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
	// max 是「本次最多返回多少字节」，必须真的按它截断：否则 from>0 时
	// 会把剩余十几 MB 一次性读进内存再序列化，一个轮询就能把 runner 打满。
	if maxBytes <= 0 || maxBytes > maxLogChunk {
		maxBytes = maxLogChunk
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
	avail := total - from
	if avail > maxBytes {
		avail = maxBytes
	}
	buf := make([]byte, avail)
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
		"log":       string(buf),
		"log_len":   total,
		"from":      from,
		"status":    status,
		"reset":     reset,
		"truncated": from+int64(len(buf)) < total,
	})
}

const maxLogChunk = 262144

// ---------- 目录浏览 ----------
// 控制面只做「路径在允许根下」的字符串校验，挡不住软链接（root/link -> /etc）。
// 目录枚举放到这里：EvalSymlinks 之后再用真实路径比根，越界的条目直接不返回。

type fsListReq struct {
	Dir   string   `json:"dir"`
	Roots []string `json:"roots"`
}

type fsEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"is_dir"`
	Size  int64  `json:"size"`
}

func (s *server) handleFsList(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "只接受 POST /fs/list"})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req fsListReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "请求体解析失败: " + err.Error()})
		return
	}
	if len(req.Roots) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "roots 不能为空"})
		return
	}
	roots := make([]string, 0, len(req.Roots))
	for _, root := range req.Roots {
		root = strings.TrimSpace(root)
		if root == "" || !filepath.IsAbs(root) {
			continue
		}
		if resolved, err := filepath.EvalSymlinks(root); err == nil {
			root = resolved
		}
		roots = append(roots, filepath.Clean(root))
	}
	if len(roots) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "roots 里没有绝对路径"})
		return
	}
	dir := strings.TrimSpace(req.Dir)
	if dir == "" {
		dir = roots[0]
	}
	if !filepath.IsAbs(dir) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "dir 必须是绝对路径"})
		return
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(dir))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "目录不存在或不可读: " + err.Error()})
		return
	}
	if !withinAnyRoot(resolved, roots) {
		writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "目录不在允许范围内: " + resolved})
		return
	}
	items, err := os.ReadDir(resolved)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	entries := make([]fsEntry, 0, len(items))
	for _, item := range items {
		name := item.Name()
		full := filepath.Join(resolved, name)
		isDir := item.IsDir()
		var size int64
		if item.Type()&os.ModeSymlink != 0 {
			// 软链接先解析，再判根：指向根外的条目直接隐藏，不给浏览器留口子。
			target, err := filepath.EvalSymlinks(full)
			if err != nil || !withinAnyRoot(target, roots) {
				continue
			}
			info, err := os.Stat(target)
			if err != nil {
				continue
			}
			isDir = info.IsDir()
			if !isDir {
				size = info.Size()
			}
		} else if info, err := item.Info(); err == nil && !isDir {
			size = info.Size()
		}
		entries = append(entries, fsEntry{Name: name, IsDir: isDir, Size: size})
	}
	// 目录在前、文件在后，与控制面原来的展示顺序一致。
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "dir": resolved, "entries": entries})
}

func withinAnyRoot(p string, roots []string) bool {
	for _, root := range roots {
		if p == root || strings.HasPrefix(p, root+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }
