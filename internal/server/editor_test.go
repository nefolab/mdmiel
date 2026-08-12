package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mdmiel/internal/store"
	"mdmiel/web"
)

// newEditorTestServer は doc.md を1本だけ置いたrootDirでサーバーを作る。
func newEditorTestServer(t *testing.T, opts ...Option) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "doc.md"), []byte("# doc\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	srv, err := NewServer(root, web.Dist, store.NewFileStore(root), opts...)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv, root
}

func getFilesResponse(t *testing.T, srv *Server) FilesResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
	req.Host = "127.0.0.1:8686" // isAllowedHost はループバックしか通さない
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/files status = %d, want 200", rec.Code)
	}
	var got FilesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body: %v (body=%q)", err, rec.Body.String())
	}
	return got
}

func TestFilesResponseCarriesRootAndDefaultEditorScheme(t *testing.T) {
	srv, root := newEditorTestServer(t)

	got := getFilesResponse(t, srv)

	if got.Root != root {
		t.Errorf("Root = %q, want %q", got.Root, root)
	}
	if got.EditorScheme != "vscode" {
		t.Errorf("EditorScheme = %q, want %q", got.EditorScheme, "vscode")
	}
	// 既存のfiles一覧が壊れていないことも同時に固定する
	if len(got.Files) != 1 || got.Files[0].Path != "doc.md" {
		t.Errorf("Files = %+v, want single doc.md entry", got.Files)
	}
}

func TestWithEditorSchemeOverridesResponse(t *testing.T) {
	srv, _ := newEditorTestServer(t, WithEditorScheme("cursor"))

	if got := getFilesResponse(t, srv).EditorScheme; got != "cursor" {
		t.Errorf("EditorScheme = %q, want %q", got, "cursor")
	}
}

func TestWithEditorSchemeRejectsInvalidValues(t *testing.T) {
	cases := []struct {
		name   string
		scheme string
	}{
		{"empty", ""},
		{"contains separator", "vscode://"},
		{"contains slash", "vscode/file"},
		{"contains colon", "vscode:"},
		{"contains space", "vs code"},
		{"contains dot", "com.example.editor"},
		{"contains plus", "vscode+insiders"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			_, err := NewServer(root, web.Dist, store.NewFileStore(root), WithEditorScheme(tc.scheme))
			if err == nil {
				t.Fatalf("NewServer with scheme %q = nil error, want error", tc.scheme)
			}
			if !strings.Contains(err.Error(), "WithEditorScheme") {
				t.Errorf("error = %v, want it to name WithEditorScheme", err)
			}
		})
	}
}

func TestWithEditorSchemeAcceptsHyphenAndDigits(t *testing.T) {
	root := t.TempDir()
	if _, err := NewServer(root, web.Dist, store.NewFileStore(root), WithEditorScheme("vscode-insiders2")); err != nil {
		t.Fatalf("NewServer with valid scheme returned error: %v", err)
	}
}
