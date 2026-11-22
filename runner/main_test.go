package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestServer(t *testing.T) *server {
	t.Helper()
	dir := t.TempDir()
	return &server{
		allow:  map[string]bool{"docker": true},
		logDir: dir,
		token:  "test-token",
		jobs:   map[string]*Job{},
		sem:    make(chan struct{}, 1),
		logMax: 1 << 20,
	}
}

func TestAuthRequired(t *testing.T) {
	s := newTestServer(t)
	h := s.auth(s.handleHealth)
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("no token: got %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/healthz", nil)
	req.Header.Set("X-Runner-Token", "test-token")
	rec = httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("with token: got %d", rec.Code)
	}
}

func TestSubmitRejectsBinaryOutsideAllowlist(t *testing.T) {
	s := newTestServer(t)
	body := `{"name":"x","steps":[{"argv":["/bin/sh","-c","id"]}]}`
	req := httptest.NewRequest(http.MethodPost, "/jobs", strings.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleJobs(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestLogRangeHonorsMax(t *testing.T) {
	s := newTestServer(t)
	path := filepath.Join(s.logDir, "job-test.log")
	if err := os.WriteFile(path, []byte(strings.Repeat("a", 600)), 0o600); err != nil {
		t.Fatal(err)
	}
	job := &Job{ID: "job-test", Status: "running", logPath: path, Steps: nil}
	s.jobs[job.ID] = job

	req := httptest.NewRequest(http.MethodGet, "/jobs/job-test/log?from=1&max=100", nil)
	req.URL.Path = "/jobs/job-test/log"
	rec := httptest.NewRecorder()
	s.handleLog(rec, req, job)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Log       string `json:"log"`
		LogLen    int64  `json:"log_len"`
		Truncated bool   `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Log) > 100 {
		t.Fatalf("returned %d bytes, want <= 100", len(out.Log))
	}
	if out.LogLen != 600 || !out.Truncated {
		t.Fatalf("len=%d truncated=%v", out.LogLen, out.Truncated)
	}
}

func TestFsListHidesSymlinkOutsideRoot(t *testing.T) {
	s := newTestServer(t)
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "sub"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "sub"), filepath.Join(root, "inside")); err != nil {
		t.Fatal(err)
	}

	body, _ := json.Marshal(map[string]any{"dir": root, "roots": []string{root}})
	req := httptest.NewRequest(http.MethodPost, "/fs/list", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	s.handleFsList(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Entries []fsEntry `json:"entries"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, e := range out.Entries {
		names[e.Name] = true
	}
	if names["escape"] {
		t.Fatalf("symlink outside root leaked: %v", names)
	}
	if !names["inside"] {
		t.Fatalf("symlink inside root missing: %v", names)
	}

	// 直接浏览根外目录也必须被拒。
	body, _ = json.Marshal(map[string]any{"dir": outside, "roots": []string{root}})
	req = httptest.NewRequest(http.MethodPost, "/fs/list", bytes.NewReader(body))
	rec = httptest.NewRecorder()
	s.handleFsList(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("outside dir: got %d", rec.Code)
	}
}
