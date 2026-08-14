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

// newFilesTestServer は隠しファイル・隠しディレクトリ・サブディレクトリを含む
// ルートディレクトリでサーバーを組み立てる。
func newFilesTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"normal.md":               "# normal\n",
		"page.html":               "<h1>page</h1>\n",
		".hidden.md":              "# hidden\n",
		".env":                    "SECRET=1\n",
		"subdir/sub.md":           "# sub\n",
		".hiddendir/inside.md":    "# inside\n",
		"node_modules/pkg/doc.md": "# dep\n",
	}
	for rel, content := range files {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir for %s: %v", rel, err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	srv, err := NewServer(root, web.Dist, store.NewFileStore(root))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv, root
}

// TestFilesListOnlyContainsOpenableEntries は「一覧に出たものは必ず開ける」という
// 不変条件を固定する。ResolveSecurePath は "." 始まりセグメントを403にするため、
// handleFiles がドット始まりファイルを載せると死んだエントリになる ( 2026-08-15の実バグ )。
// 除外規則を個別に確認するのではなく、一覧の全エントリを実際に GET することで、
// 将来どちらか片方の規則だけが変わった場合にも落ちるようにしている。
func TestFilesListOnlyContainsOpenableEntries(t *testing.T) {
	srv, _ := newFilesTestServer(t)

	got := getFilesResponse(t, srv)

	if len(got.Files) == 0 {
		t.Fatal("files list is empty; fixture or walk logic is broken")
	}
	for _, f := range got.Files {
		req := httptest.NewRequest(http.MethodGet, "/api/file?path="+f.Path, nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("listed file %q is not openable: GET /api/file status = %d, want 200", f.Path, rec.Code)
		}
	}

	// 期待する一覧そのものも固定する ( 全件除外して空にすれば上のループは通ってしまうため )
	want := []string{"normal.md", "page.html", "subdir/sub.md"}
	var paths []string
	for _, f := range got.Files {
		paths = append(paths, f.Path)
	}
	sort.Strings(paths)
	sort.Strings(want)
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Errorf("files = %v, want %v", paths, want)
	}
}

// TestFileAPIRejectsDirectory は、ディレクトリ指定が500ではなく403になることを固定する。
// os.ReadFile に渡すと EISDIR が internalError 経由で500になり、利用者の入力ミスが
// サーバー不具合として報告されていた ( 2026-08-15の実バグ )。/raw/ 側は既に403のため、
// 同じ入力に対する応答をここで揃える。
func TestFileAPIRejectsDirectory(t *testing.T) {
	srv, _ := newFilesTestServer(t)

	for _, target := range []string{"/api/file?path=subdir", "/raw/subdir"} {
		t.Run(target, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, target, nil)
			req.Host = "127.0.0.1:8686"
			rec := httptest.NewRecorder()
			srv.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("status = %d, want 403 (body=%q)", rec.Code, rec.Body.String())
			}
		})
	}
}

// TestCommentsAPIRejectsDirectory は、ディレクトリ宛のコメントが永続化されないことを
// 固定する。resolveTargetPath は実在チェックだけを行っていたため、開くことのできない
// 対象にコメントを作成できていた ( 2026-08-15の実バグ )。
func TestCommentsAPIRejectsDirectory(t *testing.T) {
	srv, root := newFilesTestServer(t)

	body := `{"path":"subdir","anchor":{"line":1,"snippet":"x","snippetHash":"h"},"body":"dir comment"}`
	req := httptest.NewRequest(http.MethodPost, "/api/comments", strings.NewReader(body))
	req.Host = "127.0.0.1:8686"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Errorf("POST /api/comments status = %d, want 403 (body=%q)", rec.Code, rec.Body.String())
	}
	// ステータスだけでなく、副作用が無いことも確認する
	entries, err := os.ReadDir(filepath.Join(root, ".mdmiel", "comments"))
	if err == nil && len(entries) > 0 {
		t.Errorf("comment files were persisted for a directory target: %d entries", len(entries))
	}

	// 一覧・取得も同じ扱いになること
	getReq := httptest.NewRequest(http.MethodGet, "/api/comments?path=subdir", nil)
	getReq.Host = "127.0.0.1:8686"
	getRec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusForbidden {
		t.Errorf("GET /api/comments status = %d, want 403", getRec.Code)
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
