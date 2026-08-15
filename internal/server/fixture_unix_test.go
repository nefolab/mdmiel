//go:build unix

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"mdmiel/internal/store"
	"mdmiel/web"
)

// TestFileAPIDoesNotHangOnFIFO は、名前付きパイプを開こうとしてリクエストが
// 戻らなくなる事故を防ぐ。os.ReadFile はFIFOに対して書き手が現れるまでブロックするため、
// 種別を確認せずに読むとハンドラが永久に占有される ( 2026-08-15に実測で25秒のテスト
// タイムアウトとして再現 )。通常ファイルかどうかを読み取り前に判定することを固定する。
func TestFileAPIDoesNotHangOnFIFO(t *testing.T) {
	root := t.TempDir()
	if err := syscall.Mkfifo(filepath.Join(root, "stream.md"), 0o644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	srv, err := NewServer(root, web.Dist, store.NewFileStore(root))
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}

	done := make(chan int, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/api/file?path=stream.md", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		srv.Handler().ServeHTTP(rec, req)
		done <- rec.Code
	}()

	select {
	case code := <-done:
		if code != http.StatusForbidden {
			t.Errorf("status = %d, want 403", code)
		}
	case <-time.After(5 * time.Second):
		// ここに来る実装はFIFOを読もうとしてブロックしている
		t.Fatal("GET /api/file on a FIFO did not return within 5s")
	}
}

// addPlatformFixtures はUnix系でしか作れない実体をフィクスチャに足し、
// 一覧に出るべきもの / 出てはいけないものを返す。
//
// ここに並ぶのは「/api/files と /api/file の判定がずれると死んだエントリになる」実例で、
// いずれも2026-08-15のレビューで実際に反例として再現したもの。Windowsではシンボリック
// リンクに特権が要り、バックスラッシュもFIFOもファイル名として成立しないため分離する。
func addPlatformFixtures(t *testing.T, root, outsideDir string) (mustList, mustNotList []string) {
	t.Helper()

	// ルート内の通常ファイルへのリンクは開けるので、一覧に残さなければならない
	// ( シンボリックリンクを一律除外する実装を落とすための正例 )
	if err := os.Symlink(filepath.Join(root, "normal.md"), filepath.Join(root, "link-ok.md")); err != nil {
		t.Fatalf("symlink link-ok.md: %v", err)
	}
	mustList = append(mustList, "link-ok.md")

	// ディレクトリへのリンク: WalkDirはIsDir()=falseと見るため、素通しすると一覧に載る
	if err := os.Symlink(filepath.Join(root, "subdir"), filepath.Join(root, "alias.md")); err != nil {
		t.Fatalf("symlink alias.md: %v", err)
	}
	// ルート外へのリンク: ResolveSecurePathが境界外として拒否する
	if err := os.Symlink(filepath.Join(outsideDir, "secret.md"), filepath.Join(root, "escape.md")); err != nil {
		t.Fatalf("symlink escape.md: %v", err)
	}
	// POSIXでは正当なファイル名だが、ResolveSecurePathはバックスラッシュを一律拒否する
	if err := os.WriteFile(filepath.Join(root, `notes\backup.md`), []byte("# bs\n"), 0o644); err != nil {
		t.Fatalf("write backslash file: %v", err)
	}
	// FIFO: 種別を見ずに os.ReadFile へ渡すと書き手を待って戻らず、リクエストがハングする
	if err := syscall.Mkfifo(filepath.Join(root, "stream.md"), 0o644); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}
	mustNotList = append(mustNotList, "alias.md", "escape.md", `notes\backup.md`, "stream.md")

	return mustList, mustNotList
}
