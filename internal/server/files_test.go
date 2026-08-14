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

// filesFixtureContent は一覧に出るべき通常ファイルとその本文。
// クエリのエスケープが要る名前 ( 空白・& ・日本語 ) を混ぜてあるのは、テストだけが
// 開けない / テストだけが開ける状況を作らないため。
var filesFixtureContent = map[string]string{
	"normal.md":     "# normal\n",
	"page.html":     "<h1>page</h1>\n",
	"subdir/sub.md": "# sub\n",
	"仕様 & メモ.md":    "# 仕様\n",
}

// newFilesTestServer は隠しファイル・隠しディレクトリ・サブディレクトリに加え、
// プラットフォーム固有の実体 ( シンボリックリンク・FIFO等 ) を含むルートで
// サーバーを組み立てる。mustList / mustNotList は一覧の期待値。
func newFilesTestServer(t *testing.T) (srv *Server, root string, mustList, mustNotList []string) {
	t.Helper()
	parent := t.TempDir()
	root = filepath.Join(parent, "root")
	outside := filepath.Join(parent, "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatalf("mkdir outside: %v", err)
	}
	if err := os.WriteFile(filepath.Join(outside, "secret.md"), []byte("# secret\n"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}

	files := map[string]string{
		".hidden.md":              "# hidden\n",
		".env":                    "SECRET=1\n",
		".hiddendir/inside.md":    "# inside\n",
		"node_modules/pkg/doc.md": "# dep\n",
	}
	for rel, content := range filesFixtureContent {
		files[rel] = content
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

	for rel := range filesFixtureContent {
		mustList = append(mustList, rel)
	}
	mustNotList = []string{".hidden.md", ".env", ".hiddendir/inside.md", "node_modules/pkg/doc.md"}

	extraList, extraNotList := addPlatformFixtures(t, root, outside)
	mustList = append(mustList, extraList...)
	mustNotList = append(mustNotList, extraNotList...)

	srv, err := NewServer(root, web.Dist, store.NewFileStore(root))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return srv, root, mustList, mustNotList
}

// TestFilesListOnlyContainsOpenableEntries は「/api/files が返したパスは必ず
// /api/file で開ける」という不変条件を固定する。
//
// 個々の除外規則ではなく不変条件そのものを検証するのは、一覧側と取得側の判定が
// 別々に育つと死んだエントリが生まれるため ( 2026-08-15に実際に起きた )。ドット始まり
// ファイルだけでなく、ディレクトリへのシンボリックリンク・ルート外へのリンク・
// バックスラッシュ入りの名前・FIFOも同じ形で反例になることを確認済み。
// ステータスだけでなく本文まで照合するのは、200を返しつつ中身が空の実装を通さないため。
func TestFilesListOnlyContainsOpenableEntries(t *testing.T) {
	srv, _, mustList, mustNotList := newFilesTestServer(t)

	got := getFilesResponse(t, srv)

	if len(got.Files) == 0 {
		t.Fatal("files list is empty; fixture or walk logic is broken")
	}
	for _, f := range got.Files {
		// 本番のフロントは encodeURIComponent を通すので、テストも同じ形で送る
		// ( 素の連結だと "&" 入りの名前をテストだけが開けないと誤判定する )
		req := httptest.NewRequest(http.MethodGet, "/api/file?path="+url.QueryEscape(f.Path), nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("listed file %q is not openable: GET /api/file status = %d, want 200", f.Path, rec.Code)
			continue
		}
		var body struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Errorf("decode /api/file body for %q: %v", f.Path, err)
			continue
		}
		if want, ok := filesFixtureContent[f.Path]; ok && body.Content != want {
			t.Errorf("content for %q = %q, want %q", f.Path, body.Content, want)
		}
	}

	// 一覧そのものも固定する ( 全件除外して空にすれば上のループは通ってしまうため )
	listed := make(map[string]bool, len(got.Files))
	var paths []string
	for _, f := range got.Files {
		listed[f.Path] = true
		paths = append(paths, f.Path)
	}
	sort.Strings(paths)
	for _, want := range mustList {
		if !listed[want] {
			t.Errorf("%q must be listed but is missing (files = %v)", want, paths)
		}
	}
	for _, unwanted := range mustNotList {
		if listed[unwanted] {
			t.Errorf("%q must not be listed (files = %v)", unwanted, paths)
		}
	}
	if len(paths) != len(mustList) {
		t.Errorf("files = %v, want exactly %v", paths, mustList)
	}
}

// TestFileAPIRejectsDirectory は、ディレクトリ指定が500ではなく403になることを固定する。
// os.ReadFile に渡すと EISDIR が internalError 経由で500になり、利用者の入力ミスが
// サーバー不具合として報告されていた ( 2026-08-15の実バグ )。/raw/ 側は既に403のため、
// 同じ入力に対する応答をここで揃える。
func TestFileAPIRejectsDirectory(t *testing.T) {
	srv, _, _, _ := newFilesTestServer(t)

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
	srv, root, _, _ := newFilesTestServer(t)

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
