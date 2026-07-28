package server

import (
	"bytes"
	"fmt"
	"log"
	"log/slog"
	"mdmiel/internal/store"
	"mdmiel/web"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// failingStore は全操作で指定エラーを返す store.Store の fake。
// store.ErrNotFound は返さない ( 404にマップされてしまうため )。
type failingStore struct {
	err error
}

func (s failingStore) List(string) ([]store.Comment, error) {
	return nil, s.err
}

func (s failingStore) Create(store.Comment) (store.Comment, error) {
	return store.Comment{}, s.err
}

func (s failingStore) Get(string) (store.Comment, error) {
	return store.Comment{}, s.err
}

func (s failingStore) Update(string, string, bool, *store.NoteOffset, bool, bool, bool) (store.Comment, error) {
	return store.Comment{}, s.err
}

func (s failingStore) Delete(string) error {
	return s.err
}

func newLoggingTestServer(t *testing.T, logger *slog.Logger) (http.Handler, string, error) {
	t.Helper()
	rootDir := filepath.Join(t.TempDir(), "root")
	if err := os.Mkdir(rootDir, 0755); err != nil {
		t.Fatalf("failed to create root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "spec.md"), []byte("# Spec\n"), 0644); err != nil {
		t.Fatalf("failed to create spec.md: %v", err)
	}

	storeErr := fmt.Errorf("open %s/.mdmiel/comments: permission denied", rootDir)
	srv, err := NewServer(rootDir, web.Dist, failingStore{err: storeErr}, WithLogger(logger))
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	return srv.Handler(), rootDir, storeErr
}

func TestInternalErrorHidesOSDetails(t *testing.T) {
	tests := []struct {
		name   string
		method string
		target string
		body   string
	}{
		{
			name:   "list",
			method: http.MethodGet,
			target: "/api/comments?path=spec.md",
		},
		{
			name:   "create",
			method: http.MethodPost,
			target: "/api/comments",
			body:   `{"path":"spec.md","anchor":{"line":1},"body":"comment"}`,
		},
		{
			name:   "get",
			method: http.MethodGet,
			target: "/api/comments/abc",
		},
		{
			name:   "update",
			method: http.MethodPatch,
			target: "/api/comments/abc",
			body:   `{"body":"updated"}`,
		},
		{
			name:   "delete",
			method: http.MethodDelete,
			target: "/api/comments/abc",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var logOutput bytes.Buffer
			handler, rootDir, _ := newLoggingTestServer(t, slog.New(slog.NewTextHandler(&logOutput, nil)))

			req := httptest.NewRequest(tt.method, tt.target, strings.NewReader(tt.body))
			req.Host = "127.0.0.1:8686"
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusInternalServerError {
				t.Errorf("expected 500, got %d", rec.Code)
			}
			if got, want := rec.Body.String(), "Internal Server Error\n"; got != want {
				t.Errorf("body = %q, want %q", got, want)
			}
			if strings.Contains(rec.Body.String(), rootDir) {
				t.Errorf("response body contains rootDir %q", rootDir)
			}
			if !strings.Contains(logOutput.String(), rootDir) {
				t.Errorf("log output does not contain rootDir %q: %s", rootDir, logOutput.String())
			}
		})
	}
}

func TestInternalErrorLogsDetails(t *testing.T) {
	var logOutput bytes.Buffer
	handler, _, storeErr := newLoggingTestServer(t, slog.New(slog.NewTextHandler(&logOutput, nil)))

	req := httptest.NewRequest(http.MethodGet, "/api/comments?path=spec.md", nil)
	req.Host = "127.0.0.1:8686"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	logged := logOutput.String()
	for _, want := range []string{
		storeErr.Error(),
		"method=GET",
		"path=/api/comments ",
		"level=ERROR",
	} {
		if !strings.Contains(logged, want) {
			t.Errorf("log output does not contain %q: %s", want, logged)
		}
	}
}

func TestNewServerUsesDefaultLoggerWhenUnset(t *testing.T) {
	oldDefault := slog.Default()
	oldLogWriter := log.Writer()
	oldLogFlags := log.Flags()
	t.Cleanup(func() {
		slog.SetDefault(oldDefault)
		log.SetOutput(oldLogWriter)
		log.SetFlags(oldLogFlags)
	})

	var constructionLogOutput bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&constructionLogOutput, nil)))

	rootDir := filepath.Join(t.TempDir(), "root")
	if err := os.Mkdir(rootDir, 0755); err != nil {
		t.Fatalf("failed to create root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "spec.md"), []byte("# Spec\n"), 0644); err != nil {
		t.Fatalf("failed to create spec.md: %v", err)
	}
	storeErr := fmt.Errorf("open %s/.mdmiel/comments: permission denied", rootDir)
	srv, err := NewServer(rootDir, web.Dist, failingStore{err: storeErr})
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	var replacementLogOutput bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&replacementLogOutput, nil)))

	req := httptest.NewRequest(http.MethodGet, "/api/comments?path=spec.md", nil)
	req.Host = "127.0.0.1:8686"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if !strings.Contains(constructionLogOutput.String(), storeErr.Error()) {
		t.Errorf("logger captured by NewServer does not contain %q: %s", storeErr, constructionLogOutput.String())
	}
	if strings.Contains(replacementLogOutput.String(), storeErr.Error()) {
		t.Errorf("logger set after NewServer unexpectedly contains %q: %s", storeErr, replacementLogOutput.String())
	}
}

func TestWithLoggerNilReturnsError(t *testing.T) {
	srv, err := NewServer(t.TempDir(), web.Dist, failingStore{}, WithLogger(nil))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if srv != nil {
		t.Errorf("expected nil server, got %#v", srv)
	}
}

func TestNewServerNilOptionReturnsError(t *testing.T) {
	srv, err := NewServer(t.TempDir(), web.Dist, failingStore{}, nil)
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if srv != nil {
		t.Errorf("expected nil server, got %#v", srv)
	}
}
