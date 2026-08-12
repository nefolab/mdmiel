package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"mdmiel/internal/auth"
	"mdmiel/internal/store"
	"mdmiel/web"
	"net/http"
	"net/http/httptest"
	"os"
	"os/user"
	"path/filepath"
	"strings"
	"testing"
)

func newAuthTestServer(t *testing.T, opts ...Option) (*Server, string) {
	t.Helper()
	rootDir := filepath.Join(t.TempDir(), "root")
	if err := os.Mkdir(rootDir, 0755); err != nil {
		t.Fatalf("failed to create root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "spec.md"), []byte("# Spec\n"), 0644); err != nil {
		t.Fatalf("failed to create spec.md: %v", err)
	}

	srv, err := NewServer(rootDir, web.Dist, store.NewFileStore(rootDir), opts...)
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	return srv, rootDir
}

func serveAuthTestRequest(handler http.Handler, method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Host = "127.0.0.1:8686"
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func alwaysUnauthorized(http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	})
}

func withTestUser(u auth.User) auth.Middleware {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = r.WithContext(auth.WithUser(r.Context(), u))
			next.ServeHTTP(w, r)
		})
	}
}

func assertPersistedAuthor(t *testing.T, rootDir, id, want string) {
	t.Helper()
	persisted, err := store.NewFileStore(rootDir).Get(id)
	if err != nil {
		t.Fatalf("failed to read persisted comment: %v", err)
	}
	if got := persisted.Author; got != want {
		t.Errorf("persisted author = %q, want %q", got, want)
	}
}

func TestWithAuthNilReturnsError(t *testing.T) {
	srv, err := NewServer(t.TempDir(), web.Dist, failingStore{}, WithAuth(nil))
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if got, want := err.Error(), "server: apply option: WithAuth: middleware must not be nil"; got != want {
		t.Errorf("error = %q, want %q", got, want)
	}
	if srv != nil {
		t.Errorf("expected nil server, got %#v", srv)
	}
}

func TestWithLoggerAndWithAuthOrderIndependent(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	tests := []struct {
		name string
		opts []Option
	}{
		{name: "logger then auth", opts: []Option{WithLogger(logger), WithAuth(alwaysUnauthorized)}},
		{name: "auth then logger", opts: []Option{WithAuth(alwaysUnauthorized), WithLogger(logger)}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, _ := newAuthTestServer(t, tt.opts...)
			if srv.logger != logger {
				t.Fatal("WithLogger result was changed by option order")
			}
			rec := serveAuthTestRequest(srv.Handler(), http.MethodGet, "/api/files", "")
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d", rec.Code)
			}
		})
	}
}

func TestAuthMiddlewareProtectsAllRoutes(t *testing.T) {
	srv, _ := newAuthTestServer(t, WithAuth(alwaysUnauthorized))
	handler := srv.Handler()

	// Handlerが実際に登録する共有ルート表を数えるため、ルートの増減もこのテストを失敗させる。
	if got, want := len(serverRoutes), 10; got != want {
		t.Fatalf("registered route count = %d, want %d", got, want)
	}
	for _, route := range serverRoutes {
		method, target := authTestRequestForRoute(t, route.pattern)
		t.Run(route.pattern, func(t *testing.T) {
			rec := serveAuthTestRequest(handler, method, target, "")
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("expected 401, got %d", rec.Code)
			}
		})
	}
}

func authTestRequestForRoute(t *testing.T, pattern string) (method, target string) {
	t.Helper()
	parts := strings.SplitN(pattern, " ", 2)
	if len(parts) != 2 {
		t.Fatalf("invalid route pattern %q", pattern)
	}
	method, target = parts[0], parts[1]
	target = strings.ReplaceAll(target, "{id...}", "abc")
	if target == "/raw/" {
		target = "/raw/x.html"
	}
	return method, target
}

func TestRequestGuardsRunBeforeAuth(t *testing.T) {
	authCalls := 0
	mw := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authCalls++
			if r.Header.Get("Authorization") == "" {
				http.Error(w, "Unauthorized", http.StatusUnauthorized)
				return
			}
			r = r.WithContext(auth.WithUser(r.Context(), auth.User{ID: "alice"}))
			next.ServeHTTP(w, r)
		})
	}
	srv, _ := newAuthTestServer(t, WithAuth(mw))
	handler := srv.Handler()

	for _, authorization := range []string{"", "Bearer valid"} {
		req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
		req.Host = "evil.com"
		req.Header.Set("Authorization", authorization)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("Authorization %q: expected 403, got %d", authorization, rec.Code)
		}
	}
	if authCalls != 0 {
		t.Errorf("auth middleware called %d times for forbidden hosts, want 0", authCalls)
	}

	t.Run("Origin", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Origin", "https://evil.example.com")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	t.Run("dot-dot segment", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/raw/../secret", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	if authCalls != 0 {
		t.Errorf("auth middleware called %d times for requests rejected by guards, want 0", authCalls)
	}
}

func TestAuthenticatedCommentUsesDisplayNameAsAuthor(t *testing.T) {
	u := auth.User{ID: "alice-id", Name: "Alice Example"}
	srv, rootDir := newAuthTestServer(t, WithAuth(withTestUser(u)))
	rec := serveAuthTestRequest(
		srv.Handler(),
		http.MethodPost,
		"/api/comments",
		`{"path":"spec.md","anchor":{"line":1},"body":"authenticated comment"}`,
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var created store.Comment
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if got, want := created.Author, u.DisplayName(); got != want {
		t.Errorf("author = %q, want %q", got, want)
	}
	assertPersistedAuthor(t, rootDir, created.ID, u.DisplayName())
}

func TestAuthenticatedCommentRequiresUserInContext(t *testing.T) {
	tests := []struct {
		name string
		mw   auth.Middleware
	}{
		{
			name: "missing user",
			mw: func(next http.Handler) http.Handler {
				return next
			},
		},
		{
			name: "empty user ID",
			mw:   withTestUser(auth.User{Name: "No ID"}),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			srv, rootDir := newAuthTestServer(t, WithAuth(tt.mw), WithLogger(logger))
			rec := serveAuthTestRequest(
				srv.Handler(),
				http.MethodPost,
				"/api/comments",
				`{"path":"spec.md","anchor":{"line":1},"body":"must fail"}`,
			)
			if rec.Code != http.StatusInternalServerError {
				t.Errorf("expected 500, got %d: %s", rec.Code, rec.Body.String())
			}
			if got, want := rec.Body.String(), "Internal Server Error\n"; got != want {
				t.Errorf("body = %q, want %q", got, want)
			}

			comments, err := store.NewFileStore(rootDir).List("spec.md")
			if err != nil {
				t.Fatalf("failed to list persisted comments: %v", err)
			}
			if len(comments) != 0 {
				t.Errorf("persisted comments = %+v, want none", comments)
			}
		})
	}
}

func TestAuthenticatedCommentUserCheckIsFailFast(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "before request validation", body: `{}`},
		{name: "before filesystem lookup", body: `{"path":"missing.md","body":"comment"}`},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mw := func(next http.Handler) http.Handler { return next }
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
			srv, _ := newAuthTestServer(t, WithAuth(mw), WithLogger(logger))
			rec := serveAuthTestRequest(srv.Handler(), http.MethodPost, "/api/comments", tt.body)
			if rec.Code != http.StatusInternalServerError {
				t.Errorf("expected 500, got %d: %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestUnauthenticatedCommentUsesOSUserAsAuthor(t *testing.T) {
	srv, rootDir := newAuthTestServer(t)
	rec := serveAuthTestRequest(
		srv.Handler(),
		http.MethodPost,
		"/api/comments",
		`{"path":"spec.md","anchor":{"line":1},"body":"local comment"}`,
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var created store.Comment
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if got, want := created.Author, expectedOSUser(); got != want {
		t.Errorf("author = %q, want OS user %q", got, want)
	}
	assertPersistedAuthor(t, rootDir, created.ID, expectedOSUser())
}

func expectedOSUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if v := os.Getenv("USER"); v != "" {
		return v
	}
	return "unknown"
}

func TestUserFromOuterMiddlewareSetsCommentAuthor(t *testing.T) {
	u := auth.User{ID: "outer-id", Name: "Outer User"}
	srv, rootDir := newAuthTestServer(t)
	handler := withTestUser(u)(srv.Handler())
	rec := serveAuthTestRequest(
		handler,
		http.MethodPost,
		"/api/comments",
		`{"path":"spec.md","anchor":{"line":1},"body":"outer auth comment"}`,
	)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var created store.Comment
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if got, want := created.Author, u.DisplayName(); got != want {
		t.Errorf("author = %q, want %q", got, want)
	}
	assertPersistedAuthor(t, rootDir, created.ID, u.DisplayName())
}

func TestAuthMiddlewareReturningNilPanics(t *testing.T) {
	mw := func(http.Handler) http.Handler { return nil }
	srv, _ := newAuthTestServer(t, WithAuth(mw))

	defer func() {
		got := recover()
		if got == nil {
			t.Fatal("Handler did not panic")
		}
		if want := "server: auth middleware returned a nil handler"; got != want {
			t.Errorf("panic = %q, want %q", got, want)
		}
	}()
	_ = srv.Handler()
}

func TestPatchDoesNotChangeAuthor(t *testing.T) {
	mw := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			name := r.Header.Get("X-Test-User")
			r = r.WithContext(auth.WithUser(r.Context(), auth.User{ID: name, Name: name}))
			next.ServeHTTP(w, r)
		})
	}
	srv, rootDir := newAuthTestServer(t, WithAuth(mw))
	handler := srv.Handler()

	createReq := httptest.NewRequest(
		http.MethodPost,
		"/api/comments",
		strings.NewReader(`{"path":"spec.md","anchor":{"line":1},"body":"original"}`),
	)
	createReq.Host = "127.0.0.1:8686"
	createReq.Header.Set("X-Test-User", "Alice")
	createRec := httptest.NewRecorder()
	handler.ServeHTTP(createRec, createReq)
	if createRec.Code != http.StatusCreated {
		t.Fatalf("create: expected 201, got %d: %s", createRec.Code, createRec.Body.String())
	}
	var created store.Comment
	if err := json.Unmarshal(createRec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode create response: %v", err)
	}

	patchReq := httptest.NewRequest(
		http.MethodPatch,
		"/api/comments/"+created.ID,
		strings.NewReader(`{"body":"updated"}`),
	)
	patchReq.Host = "127.0.0.1:8686"
	patchReq.Header.Set("X-Test-User", "Bob")
	patchRec := httptest.NewRecorder()
	handler.ServeHTTP(patchRec, patchReq)
	if patchRec.Code != http.StatusOK {
		t.Fatalf("patch: expected 200, got %d: %s", patchRec.Code, patchRec.Body.String())
	}
	var patched store.Comment
	if err := json.Unmarshal(patchRec.Body.Bytes(), &patched); err != nil {
		t.Fatalf("failed to decode patch response: %v", err)
	}
	if got, want := patched.Author, "Alice"; got != want {
		t.Errorf("author after PATCH = %q, want %q", got, want)
	}
	if got, want := patched.Body, "updated"; got != want {
		t.Errorf("body after PATCH = %q, want %q", got, want)
	}
	assertPersistedAuthor(t, rootDir, created.ID, "Alice")
}

func TestAuthMiddlewareCanHandleCallbackBeforeSPA(t *testing.T) {
	mw := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/auth/callback" {
				w.Header().Set("X-Auth-Callback", "handled")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
	srv, _ := newAuthTestServer(t, WithAuth(mw))
	rec := serveAuthTestRequest(srv.Handler(), http.MethodGet, "/auth/callback", "")
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", rec.Code, rec.Body.String())
	}
	if got, want := rec.Header().Get("X-Auth-Callback"), "handled"; got != want {
		t.Errorf("X-Auth-Callback = %q, want %q", got, want)
	}
}

func TestAuthMiddlewareWrappedOncePerHandler(t *testing.T) {
	wraps := 0
	mw := func(next http.Handler) http.Handler {
		wraps++
		return next
	}
	srv, _ := newAuthTestServer(t, WithAuth(mw))
	handler := srv.Handler()
	if wraps != 1 {
		t.Fatalf("middleware wrapped %d times while constructing Handler, want 1", wraps)
	}

	for range 2 {
		rec := serveAuthTestRequest(handler, http.MethodGet, "/api/files", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
	}
	if wraps != 1 {
		t.Errorf("middleware wrapped %d times after serving requests, want 1", wraps)
	}
}
