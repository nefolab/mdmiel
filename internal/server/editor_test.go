package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
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

// filesWire は /api/files のJSONを、実装の構造体を経由せずキー名ごと検証するための型。
// FilesResponse をそのままデコードに使うと、jsonタグを改名する変異 ( フロントからは
// 値が読めなくなる ) をテストが素通ししてしまうため、wire側の契約を別に持つ。
type filesWire struct {
	Files []struct {
		Path string `json:"path"`
		Type string `json:"type"`
	} `json:"files"`
	Root         string `json:"root"`
	EditorScheme string `json:"editorScheme"`
}

func getFilesResponse(t *testing.T, srv *Server) (filesWire, map[string]json.RawMessage) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
	req.Host = "127.0.0.1:8686" // isAllowedHost はループバックしか通さない
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/files status = %d, want 200", rec.Code)
	}
	var got filesWire
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body: %v (body=%q)", err, rec.Body.String())
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("decode body as object: %v (body=%q)", err, rec.Body.String())
	}
	return got, keys
}

func TestFilesResponseCarriesRootAndDefaultEditorScheme(t *testing.T) {
	srv, root := newEditorTestServer(t)

	got, keys := getFilesResponse(t, srv)

	// フロント ( Sidebar.tsx ) が読むキー名そのものを固定する
	for _, key := range []string{"files", "root", "editorScheme"} {
		if _, ok := keys[key]; !ok {
			t.Errorf("response is missing key %q (got keys %v)", key, keysOf(keys))
		}
	}

	if got.Root != filepath.ToSlash(root) {
		t.Errorf("root = %q, want %q", got.Root, filepath.ToSlash(root))
	}
	if got.EditorScheme != "vscode" {
		t.Errorf("editorScheme = %q, want %q", got.EditorScheme, "vscode")
	}
	// 既存のfiles一覧が壊れていないことも同時に固定する
	if len(got.Files) != 1 || got.Files[0].Path != "doc.md" {
		t.Errorf("files = %+v, want single doc.md entry", got.Files)
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestFilesResponseRootUsesSlashSeparators は、パス区切りの吸収がサーバー側にある
// ことを固定する。フロントは受け取った root の "\" を区切りとして扱わないため、
// ここでネイティブ表記のまま返すとWindowsでリンクが壊れる。
func TestFilesResponseRootUsesSlashSeparators(t *testing.T) {
	srv, root := newEditorTestServer(t)

	got, _ := getFilesResponse(t, srv)

	if strings.Contains(got.Root, `\`) {
		t.Errorf("root = %q, want no backslash separators", got.Root)
	}
	if got.Root != filepath.ToSlash(root) {
		t.Errorf("root = %q, want ToSlash(%q) = %q", got.Root, root, filepath.ToSlash(root))
	}
}

func TestWithEditorSchemeOverridesResponse(t *testing.T) {
	srv, _ := newEditorTestServer(t, WithEditorScheme("cursor"))

	got, _ := getFilesResponse(t, srv)
	if got.EditorScheme != "cursor" {
		t.Errorf("editorScheme = %q, want %q", got.EditorScheme, "cursor")
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
		{"contains underscore", "vs_code"},
		{"leading digit", "1editor"},
		{"leading hyphen", "-editor"},
		{"newline suffix", "vscode\n"},
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

// TestWithEditorSchemeRejectsBrowserHandledSchemes は、生成URLがアンカーのhrefに
// 入ることを踏まえた拒否リストを固定する。javascript を通すと、ファイル名に仕込んだ
// コードがクリック時にページ内で実行される。
func TestWithEditorSchemeRejectsBrowserHandledSchemes(t *testing.T) {
	for _, scheme := range []string{"javascript", "JavaScript", "vbscript", "data", "blob", "file", "http", "https", "about", "ws", "wss"} {
		t.Run(scheme, func(t *testing.T) {
			root := t.TempDir()
			_, err := NewServer(root, web.Dist, store.NewFileStore(root), WithEditorScheme(scheme))
			if err == nil {
				t.Fatalf("NewServer with scheme %q = nil error, want error", scheme)
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
