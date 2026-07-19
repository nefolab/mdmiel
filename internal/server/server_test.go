package server

import (
	"encoding/json"
	"mdmiel/internal/store"
	"mdmiel/web"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServer(t *testing.T) {
	// 一時的なルートディレクトリを作成
	tmpDir := t.TempDir()
	rootDir := filepath.Join(tmpDir, "root")
	if err := os.Mkdir(rootDir, 0755); err != nil {
		t.Fatalf("failed to create root: %v", err)
	}

	// テスト用のファイル配置
	filesToCreate := map[string]string{
		"spec.md":                   "# Specification",
		"mock.html":                 "<html></html>",
		"style.css":                 "body {}",
		".mdmiel/comments/123.json": `{"id":"123"}`,
		"node_modules/dep/a.md":     "# Dependency",
		".git/config":               "git config",
		"sub/doc.md":                "# Sub Doc",
	}

	for rel, content := range filesToCreate {
		fullPath := filepath.Join(rootDir, rel)
		dir := filepath.Dir(fullPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatalf("failed to create dir %s: %v", dir, err)
		}
		if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
			t.Fatalf("failed to write file %s: %v", fullPath, err)
		}
	}

	// サーバーインスタンス作成
	srv, err := NewServer(rootDir, web.Dist, store.NewFileStore(rootDir))
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}

	handler := srv.Handler()

	// 1. GET /api/files のテスト
	t.Run("GET /api/files", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/files", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", rec.Code)
		}

		var resp FilesResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		// 期待されるファイル: spec.md, mock.html, sub/doc.md
		// 除外されるべきファイル: .mdmiel/, node_modules/, .git/
		expectedFiles := map[string]bool{
			"spec.md":    true,
			"mock.html":  true,
			"sub/doc.md": true,
		}

		for _, f := range resp.Files {
			if !expectedFiles[f.Path] {
				t.Errorf("unexpected file returned: %s", f.Path)
			}
			delete(expectedFiles, f.Path)
		}

		if len(expectedFiles) > 0 {
			t.Errorf("missing expected files: %v", expectedFiles)
		}
	})

	// 2. GET /api/file のテスト ( 正常系 )
	t.Run("GET /api/file success", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/file?path=spec.md", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", rec.Code)
		}

		var resp FileResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if resp.Path != "spec.md" {
			t.Errorf("expected spec.md, got %s", resp.Path)
		}
		if resp.Type != "markdown" {
			t.Errorf("expected markdown type, got %s", resp.Type)
		}
		if resp.Content != "# Specification" {
			t.Errorf("expected content # Specification, got %s", resp.Content)
		}
	})

	// 3. GET /api/file のテスト ( 存在しない )
	t.Run("GET /api/file not found", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/file?path=missing.md", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", rec.Code)
		}
	})

	// 4. GET /api/file のテスト ( パストラバーサル拒否 )
	t.Run("GET /api/file traversal forbidden", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/file?path=../unsafe.txt", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	// 5. GET /raw/ のテスト
	t.Run("GET /raw/ style.css", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/raw/style.css", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", rec.Code)
		}
		if !strings.Contains(rec.Body.String(), "body {}") {
			t.Errorf("expected body to contain CSS content, got %s", rec.Body.String())
		}
	})

	// 6. GET /raw/ パストラバーサル拒否
	t.Run("GET /raw/ traversal forbidden", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/raw/../unsafe.txt", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	// 6b. GET /raw/ dotセグメント拒否 ( .mdmiel 等の隠しディレクトリへの直接アクセス )
	t.Run("GET /raw/ .mdmiel forbidden", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/raw/.mdmiel/comments/123.json", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	// 7. SPA フォールバックのテスト
	t.Run("SPA Fallback", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/some/spa/route", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		if rec.Code != http.StatusOK {
			t.Errorf("expected 200, got %d", rec.Code)
		}
		// dist はフロントのビルド成果物で中身が入れ替わるため、内容そのものには依存しない
		if !strings.Contains(strings.ToLower(rec.Body.String()), "<html") {
			t.Errorf("expected index.html content, got %s", rec.Body.String())
		}
	})

	// 8. Hostヘッダ検証のテスト ( DNS rebinding対策 )
	t.Run("Host header validation", func(t *testing.T) {
		allowedHosts := []string{"127.0.0.1:8686", "127.0.0.1", "localhost:8686", "localhost", "[::1]:8686", "::1"}
		for _, h := range allowedHosts {
			req := httptest.NewRequest("GET", "/api/files", nil)
			req.Host = h
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusOK {
				t.Errorf("host %q: expected 200, got %d", h, rec.Code)
			}
		}

		forbiddenHosts := []string{"example.com", "evil.com:8686", "192.168.1.10:8686"}
		for _, h := range forbiddenHosts {
			req := httptest.NewRequest("GET", "/api/files", nil)
			req.Host = h
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)

			if rec.Code != http.StatusForbidden {
				t.Errorf("host %q: expected 403, got %d", h, rec.Code)
			}
		}
	})
}

// newCommentsTestServer はコメントAPIテスト用に、spec.mdを1つ持つルートディレクトリと
// FileStoreを注入したサーバーを準備する。
func newCommentsTestServer(t *testing.T) (http.Handler, string) {
	t.Helper()
	tmpDir := t.TempDir()
	rootDir := filepath.Join(tmpDir, "root")
	if err := os.Mkdir(rootDir, 0755); err != nil {
		t.Fatalf("failed to create root: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "spec.md"), []byte("# Spec\n\nline2\n"), 0644); err != nil {
		t.Fatalf("failed to create spec.md: %v", err)
	}

	srv, err := NewServer(rootDir, web.Dist, store.NewFileStore(rootDir))
	if err != nil {
		t.Fatalf("failed to create server: %v", err)
	}
	return srv.Handler(), rootDir
}

func TestCommentsAPI(t *testing.T) {
	handler, rootDir := newCommentsTestServer(t)

	// path未指定は400
	t.Run("GET /api/comments without path", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/comments", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})

	// POST /api/comments で作成すると201が返り、.mdmiel/comments/<id>.jsonに永続化される
	createBody := `{"path":"spec.md","anchor":{"line":1,"snippet":"# Spec","snippetHash":"h1"},"body":"first comment"}`
	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(createBody))
	req.Host = "127.0.0.1:8686"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}

	var created store.Comment
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode created comment: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected generated id")
	}
	if created.Version != 1 {
		t.Errorf("expected version 1, got %d", created.Version)
	}

	commentFile := filepath.Join(rootDir, ".mdmiel", "comments", created.ID+".json")
	if _, err := os.Stat(commentFile); err != nil {
		t.Errorf("expected comment file to be persisted: %v", err)
	}

	// GET /api/comments?path=spec.md で取得できる
	req = httptest.NewRequest("GET", "/api/comments?path=spec.md", nil)
	req.Host = "127.0.0.1:8686"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var listResp CommentsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("failed to decode list response: %v", err)
	}
	if len(listResp.Comments) != 1 || listResp.Comments[0].ID != created.ID {
		t.Errorf("unexpected list result: %+v", listResp.Comments)
	}

	// PATCH で resolved 切替が反映される ( body は変化しない )
	patchBody := `{"resolved":true}`
	req = httptest.NewRequest("PATCH", "/api/comments/"+created.ID, strings.NewReader(patchBody))
	req.Host = "127.0.0.1:8686"
	req.Header.Set("Content-Type", "application/json")
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var patched store.Comment
	if err := json.Unmarshal(rec.Body.Bytes(), &patched); err != nil {
		t.Fatalf("failed to decode patched comment: %v", err)
	}
	if !patched.Resolved {
		t.Error("expected resolved=true after patch")
	}
	if patched.Body != "first comment" {
		t.Errorf("expected body unchanged, got %s", patched.Body)
	}

	// PATCH で存在しないidは404
	t.Run("PATCH unknown id", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/00000000-0000-4000-8000-000000000000", strings.NewReader(`{"resolved":true}`))
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", rec.Code)
		}
	})

	// PATCH で有効なnoteOffsetを指定すると200が返り、永続化されたコメントに反映される
	t.Run("PATCH with valid noteOffset persists it", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/"+created.ID, strings.NewReader(`{"noteOffset":{"dx":15.5,"dy":-8}}`))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var patched store.Comment
		if err := json.Unmarshal(rec.Body.Bytes(), &patched); err != nil {
			t.Fatalf("failed to decode patched comment: %v", err)
		}
		if patched.NoteOffset == nil || patched.NoteOffset.DX != 15.5 || patched.NoteOffset.DY != -8 {
			t.Errorf("expected noteOffset {15.5 -8}, got %+v", patched.NoteOffset)
		}
	})

	// PATCH で範囲外のnoteOffsetは[-20000, 20000]にクランプされる
	t.Run("PATCH with out-of-range noteOffset is clamped", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/"+created.ID, strings.NewReader(`{"noteOffset":{"dx":99999,"dy":-99999}}`))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var patched store.Comment
		if err := json.Unmarshal(rec.Body.Bytes(), &patched); err != nil {
			t.Fatalf("failed to decode patched comment: %v", err)
		}
		if patched.NoteOffset == nil || patched.NoteOffset.DX != 20000 || patched.NoteOffset.DY != -20000 {
			t.Errorf("expected noteOffset clamped to {20000 -20000}, got %+v", patched.NoteOffset)
		}
	})

	// PATCH で不正な型 ( 数値でないdx ) を指定すると400
	t.Run("PATCH with malformed noteOffset returns 400", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/"+created.ID, strings.NewReader(`{"noteOffset":{"dx":"not-a-number","dy":1}}`))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	// DELETE で204、その後GETで消えている
	req = httptest.NewRequest("DELETE", "/api/comments/"+created.ID, nil)
	req.Host = "127.0.0.1:8686"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d", rec.Code)
	}

	req = httptest.NewRequest("GET", "/api/comments?path=spec.md", nil)
	req.Host = "127.0.0.1:8686"
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	listResp = CommentsResponse{}
	if err := json.Unmarshal(rec.Body.Bytes(), &listResp); err != nil {
		t.Fatalf("failed to decode list response: %v", err)
	}
	if len(listResp.Comments) != 0 {
		t.Errorf("expected no comments after delete, got %+v", listResp.Comments)
	}

	// DELETE で既に消えているidは404
	t.Run("DELETE already deleted id", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/comments/"+created.ID, nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", rec.Code)
		}
	})
}

// TestCommentGetByID は GET /api/comments/{id} の200 ( 作成→取得一致 ) / 404 ( 未知ID ) /
// 不正ID形式 ( 既存のPATCH/DELETEハンドラの慣例に合わせ400 ) を確認する。
func TestCommentGetByID(t *testing.T) {
	handler, _ := newCommentsTestServer(t)

	createBody := `{"path":"spec.md","anchor":{"line":1,"snippet":"# Spec","snippetHash":"h1"},"body":"gettable comment"}`
	req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(createBody))
	req.Host = "127.0.0.1:8686"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("expected 201, got %d: %s", rec.Code, rec.Body.String())
	}
	var created store.Comment
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode created comment: %v", err)
	}

	t.Run("GET existing id returns 200 and matches created comment", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/comments/"+created.ID, nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
		}
		var got store.Comment
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if got.ID != created.ID || got.Body != created.Body || got.Path != created.Path {
			t.Errorf("expected comment to match created one, got %+v", got)
		}
	})

	t.Run("GET unknown id returns 404", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/comments/00000000-0000-4000-8000-000000000000", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", rec.Code)
		}
	})

	t.Run("GET malformed id returns 400 (matches PATCH/DELETE convention)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/comments/a/b", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})
}

// TestCommentIDValidationRejectsTraversal はidパラメータを介したトラバーサル試行が
// 拒否されることを確認する。
//
// 実装上の注意: サーバーは既存のグローバルガード ( ".."という完全一致のURLパスセグメントを
// 検出すると403にする、フェーズ1から存在する仕組み ) を、/api/comments/{id} にも
// そのまま適用している。そのため "/api/comments/../x" のようにURLパス上にリテラルな
// ".." セグメントを含むリクエストは、コメントAPI固有のIDバリデーション ( 正規表現
// ^[0-9a-fA-F-]+$ ) に到達する前に、そのグローバルガードにより403で拒否される。
// 一方 "a/b" のようにスラッシュを含むが ".." ではない不正なidは、{id...}ワイルドカードで
// ハンドラまで到達したうえで、IDバリデーションにより400で拒否される。
// いずれの経路でもトラバーサル試行は最終的に拒否される。
func TestCommentIDValidationRejectsTraversal(t *testing.T) {
	handler, _ := newCommentsTestServer(t)

	t.Run("PATCH with multi-segment id (a/b) rejected by ID validation (400)", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/a/b", strings.NewReader(`{"resolved":true}`))
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("DELETE with multi-segment id (a/b) rejected by ID validation (400)", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/comments/a/b", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("PATCH with dotted id (a.b) rejected by ID validation (400)", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/a.b", strings.NewReader(`{"resolved":true}`))
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d", rec.Code)
		}
	})

	t.Run("PATCH with literal .. path segment rejected by global traversal guard (403)", func(t *testing.T) {
		req := httptest.NewRequest("PATCH", "/api/comments/../x", strings.NewReader(`{"resolved":true}`))
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	t.Run("DELETE with literal .. path segment rejected by global traversal guard (403)", func(t *testing.T) {
		req := httptest.NewRequest("DELETE", "/api/comments/../x", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})
}

func TestCommentsPathTraversalForbidden(t *testing.T) {
	handler, _ := newCommentsTestServer(t)

	t.Run("POST with traversal path forbidden", func(t *testing.T) {
		body := `{"path":"../evil.md","anchor":{"line":1,"snippet":"x","snippetHash":"h"},"body":"c"}`
		req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(body))
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	t.Run("POST with dot segment path forbidden", func(t *testing.T) {
		body := `{"path":".mdmiel/comments/x.json","anchor":{"line":1,"snippet":"x","snippetHash":"h"},"body":"c"}`
		req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(body))
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	t.Run("GET with traversal path forbidden", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/comments?path=../evil.md", nil)
		req.Host = "127.0.0.1:8686"
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})
}

func TestCommentsBodySizeLimit(t *testing.T) {
	handler, _ := newCommentsTestServer(t)

	// 1MB上限を超える本文 ( 2MB ) を送ると413を返す
	oversized := strings.Repeat("a", 2<<20)
	body := `{"path":"spec.md","anchor":{"line":1,"snippet":"x","snippetHash":"h"},"body":"` + oversized + `"}`

	t.Run("POST oversized body returns 413", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(body))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("expected 413, got %d", rec.Code)
		}
	})

	t.Run("PATCH oversized body returns 413", func(t *testing.T) {
		patchBody := `{"body":"` + oversized + `"}`
		req := httptest.NewRequest("PATCH", "/api/comments/00000000-0000-4000-8000-000000000000", strings.NewReader(patchBody))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("expected 413, got %d", rec.Code)
		}
	})
}

func TestOriginValidation(t *testing.T) {
	handler, _ := newCommentsTestServer(t)

	newPostReq := func(origin string) *http.Request {
		body := `{"path":"spec.md","anchor":{"line":1,"snippet":"# Spec","snippetHash":"h"},"body":"c"}`
		req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(body))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return req
	}

	t.Run("different origin rejected (403)", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newPostReq("http://evil.com"))
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})

	t.Run("no origin header allowed (curl / same-origin navigation)", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newPostReq(""))
		if rec.Code != http.StatusCreated {
			t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("http://localhost:8686 origin allowed", func(t *testing.T) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newPostReq("http://localhost:8686"))
		if rec.Code != http.StatusCreated {
			t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	// M2: Origin検証は状態変更メソッドに限らず、Originヘッダを持つ全リクエストが対象。
	t.Run("GET with disallowed origin rejected (403)", func(t *testing.T) {
		req := httptest.NewRequest("GET", "/api/comments?path=spec.md", nil)
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Origin", "http://evil.com")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("expected 403, got %d", rec.Code)
		}
	})
}

// H3+L5: POST /api/comments のAnchorバリデーション。
// type は ""(行アンカー) か "dom"(DOM要素アンカー) のみ許可し、それ以外は400。
// type=="dom" のときはselectorが必須で、空なら400。
func TestCommentsCreateAnchorValidation(t *testing.T) {
	handler, _ := newCommentsTestServer(t)

	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/api/comments", strings.NewReader(body))
		req.Host = "127.0.0.1:8686"
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	t.Run("unknown anchor.type rejected (400)", func(t *testing.T) {
		body := `{"path":"spec.md","anchor":{"line":1,"snippet":"# Spec","snippetHash":"h","type":"bogus"},"body":"c"}`
		rec := post(body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("anchor.type dom with empty selector rejected (400)", func(t *testing.T) {
		body := `{"path":"spec.md","anchor":{"line":0,"snippet":"Submit","snippetHash":"h","type":"dom","selector":""},"body":"c"}`
		rec := post(body)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("anchor.type dom with selector accepted (201)", func(t *testing.T) {
		body := `{"path":"spec.md","anchor":{"line":0,"snippet":"Submit","snippetHash":"h","type":"dom","selector":"#submit-btn"},"body":"c"}`
		rec := post(body)
		if rec.Code != http.StatusCreated {
			t.Errorf("expected 201, got %d: %s", rec.Code, rec.Body.String())
		}
		var created store.Comment
		if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
			t.Fatalf("failed to decode created comment: %v", err)
		}
		if created.Anchor.Type != "dom" || created.Anchor.Selector != "#submit-btn" {
			t.Errorf("unexpected anchor persisted: %+v", created.Anchor)
		}
	})
}
