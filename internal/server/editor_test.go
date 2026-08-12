package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
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

// fileWire は /api/file のJSONを、実装の構造体を経由せずキー名ごと検証するための型。
// FileResponse をそのままデコードに使うと、jsonタグを改名する変異 ( フロントからは
// 値が読めなくなる ) をテストが素通ししてしまうため、wire側の契約を別に持つ。
type fileWire struct {
	Path         string `json:"path"`
	Type         string `json:"type"`
	Content      string `json:"content"`
	AbsPath      string `json:"absPath"`
	EditorScheme string `json:"editorScheme"`
}

func getFileResponse(t *testing.T, srv *Server, relPath string) (fileWire, map[string]json.RawMessage) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/file?path="+url.QueryEscape(relPath), nil)
	req.Host = "127.0.0.1:8686" // isAllowedHost はループバックしか通さない
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/file status = %d, want 200", rec.Code)
	}
	var got fileWire
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode body: %v (body=%q)", err, rec.Body.String())
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("decode body as object: %v (body=%q)", err, rec.Body.String())
	}
	return got, keys
}

func TestFileResponseCarriesAbsPathAndDefaultEditorScheme(t *testing.T) {
	srv, root := newEditorTestServer(t)

	got, keys := getFileResponse(t, srv, "doc.md")

	// フロント ( SplitView.tsx ) が読むキー名そのものを固定する
	for _, key := range []string{"path", "type", "content", "absPath", "editorScheme"} {
		if _, ok := keys[key]; !ok {
			t.Errorf("response is missing key %q (got keys %v)", key, keysOf(keys))
		}
	}

	// ResolveSecurePath はシンボリックリンクを解決するため ( macOSの /var は
	// /private/var への symlink )、期待値も実体パスで組む
	wantAbs := filepath.ToSlash(filepath.Join(evalSymlinks(t, root), "doc.md"))
	if got.AbsPath != wantAbs {
		t.Errorf("absPath = %q, want %q", got.AbsPath, wantAbs)
	}
	if got.EditorScheme != "vscode" {
		t.Errorf("editorScheme = %q, want %q", got.EditorScheme, "vscode")
	}
	// 既存フィールドが壊れていないことも同時に固定する
	if got.Path != "doc.md" || got.Type != "markdown" || got.Content != "# doc\n" {
		t.Errorf("path/type/content = %q/%q/%q, want doc.md/markdown/\"# doc\\n\"", got.Path, got.Type, got.Content)
	}
}

// TestFilesResponseHasNoEditorFields は、エディタ用の情報が一覧APIには載らないことを
// 固定する。絶対パスの露出点を「開いたファイルの取得」1箇所に閉じるための契約。
func TestFilesResponseHasNoEditorFields(t *testing.T) {
	srv, _ := newEditorTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/files", nil)
	req.Host = "127.0.0.1:8686"
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/files status = %d, want 200", rec.Code)
	}

	var keys map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &keys); err != nil {
		t.Fatalf("decode body as object: %v", err)
	}
	for _, key := range []string{"root", "absPath", "editorScheme"} {
		if _, ok := keys[key]; ok {
			t.Errorf("/api/files must not expose %q (got keys %v)", key, keysOf(keys))
		}
	}
}

// evalSymlinks はテストの期待値をサーバーと同じ実体パスに揃える。
func evalSymlinks(t *testing.T, p string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", p, err)
	}
	return resolved
}

func keysOf(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// TestFileResponseAbsPathUsesSlashSeparators は、パス区切りの吸収がサーバー側にある
// ことを固定する。フロントは受け取った absPath の "\" を区切りとして扱わないため、
// ここでネイティブ表記のまま返すとWindowsでリンクが壊れる。
// POSIXでは filepath.ToSlash が恒等変換なので、この検査が実際に効くのはWindowsのみ。
func TestFileResponseAbsPathUsesSlashSeparators(t *testing.T) {
	srv, root := newEditorTestServer(t)

	got, _ := getFileResponse(t, srv, "doc.md")

	if strings.Contains(got.AbsPath, `\`) {
		t.Errorf("absPath = %q, want no backslash separators", got.AbsPath)
	}
	want := filepath.ToSlash(filepath.Join(evalSymlinks(t, root), "doc.md"))
	if got.AbsPath != want {
		t.Errorf("absPath = %q, want %q", got.AbsPath, want)
	}
}

func TestWithEditorSchemeOverridesResponse(t *testing.T) {
	srv, _ := newEditorTestServer(t, WithEditorScheme("cursor"))

	got, _ := getFileResponse(t, srv, "doc.md")
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
