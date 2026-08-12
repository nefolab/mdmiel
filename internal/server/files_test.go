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

// filesWire は /api/files のJSONを、実装の構造体を経由せずキー名ごと検証するための型。
// FilesResponse をそのままデコードに使うと、jsonタグを改名する変異 ( フロントからは
// 値が読めなくなる ) をテストが素通ししてしまう。
type filesWire struct {
	Files []struct {
		Path string `json:"path"`
		Type string `json:"type"`
	} `json:"files"`
	RootName string `json:"rootName"`
}

func getFilesResponse(t *testing.T, srv *Server) filesWire {
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
	return got
}

// TestFilesResponseCarriesRootName は、サイドバーの見出しに出すディレクトリ名が
// 配信中のディレクトリに追随することを固定する。固定値やrootDir全体を返す実装では
// 落ちるよう、名前を指定した一時ディレクトリで検証する。
func TestFilesResponseCarriesRootName(t *testing.T) {
	// 期待値をリテラルで書くと、handleFiles が同じ固定値を返す変異を素通しする。
	// テスト名から一意な名前を作り、期待値もそこから算出する
	dirName := "root-" + strings.ReplaceAll(t.Name(), "/", "-")
	parent := t.TempDir()
	root := filepath.Join(parent, dirName)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatalf("mkdir fixture: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "doc.md"), []byte("# doc\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	srv, err := NewServer(root, web.Dist, store.NewFileStore(root))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	got := getFilesResponse(t, srv)

	if got.RootName != dirName {
		t.Errorf("rootName = %q, want %q", got.RootName, dirName)
	}
	// 絶対パスを見出しに使っていないこと ( 親ディレクトリ名が混ざらない )
	if got.RootName == root {
		t.Errorf("rootName must be the directory name, not the whole path: %q", got.RootName)
	}
	// 一覧が壊れていないことも同時に固定する
	if len(got.Files) != 1 || got.Files[0].Path != "doc.md" {
		t.Errorf("files = %+v, want single doc.md entry", got.Files)
	}
}

// TestRootDisplayName は、見出しとして意味を成さない値を空文字に落とす分岐を固定する。
// 空文字のときフロントは既定文言 ( ファイル一覧 ) を出す。
func TestRootDisplayName(t *testing.T) {
	cases := []struct {
		name    string
		rootDir string
		want    string
	}{
		{"normal directory", filepath.Join("home", "me", "Workspace"), "Workspace"},
		{"trailing separator", filepath.Join("home", "me", "Workspace") + string(filepath.Separator), "Workspace"},
		{"posix root", "/", ""},
		{"dot", ".", ""},
		{"empty", "", ""},
		// rootDir は絶対パスに正規化済みが前提なので ".." は本来到達しない。
		// 前提が崩れたときに気づけるよう、現在の挙動を明示しておく
		{"parent (contract violation)", "..", ".."},
		{"dotted directory", filepath.Join("home", ".mdmiel"), ".mdmiel"},
		{"name with spaces", filepath.Join("home", "my docs"), "my docs"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rootDisplayName(tc.rootDir); got != tc.want {
				t.Errorf("rootDisplayName(%q) = %q, want %q", tc.rootDir, got, tc.want)
			}
		})
	}
}

// TestFilesResponseRootNameFollowsTheServedDirectory は、サーバーごとに rootName が
// 変わることを固定する。1つのディレクトリしか見ないテストでは、固定値を返す実装を
// 検出できない。
func TestFilesResponseRootNameFollowsTheServedDirectory(t *testing.T) {
	parent := t.TempDir()

	for _, name := range []string{"alpha", "beta-docs"} {
		root := filepath.Join(parent, name)
		if err := os.MkdirAll(root, 0o755); err != nil {
			t.Fatalf("mkdir fixture: %v", err)
		}
		srv, err := NewServer(root, web.Dist, store.NewFileStore(root))
		if err != nil {
			t.Fatalf("NewServer: %v", err)
		}
		if got := getFilesResponse(t, srv).RootName; got != name {
			t.Errorf("rootName = %q, want %q", got, name)
		}
	}
}
