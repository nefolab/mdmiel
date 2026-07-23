package server

import (
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"mdmiel/internal/fsutil"
	"mdmiel/internal/store"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

type Server struct {
	rootDir             string
	webDist             embed.FS
	subFS               fs.FS
	store               store.Store
	hub                 *eventHub
	startLiveReloadOnce sync.Once
}

// NewServer はrootDir配下を配信するmdmielサーバーを作る。
// stは行コメントの永続化先 ( 通常はstore.NewFileStore(rootDir) ) を注入する。
func NewServer(rootDir string, webDist embed.FS, st store.Store) (*Server, error) {
	subFS, err := fs.Sub(webDist, "dist")
	if err != nil {
		return nil, err
	}
	return &Server{
		rootDir: rootDir,
		webDist: webDist,
		subFS:   subFS,
		store:   st,
		hub:     newEventHub(),
	}, nil
}

// StartLiveReload starts forwarding watcher revisions to SSE subscribers.
// Calling it more than once is intentionally ignored.
func (s *Server) StartLiveReload(revisions <-chan int) {
	s.startLiveReloadOnce.Do(func() { go s.hub.run(revisions) })
}

type FileEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

type FilesResponse struct {
	Files []FileEntry `json:"files"`
}

type FileResponse struct {
	Path    string `json:"path"`
	Type    string `json:"type"`
	Content string `json:"content"`
}

// maxCommentBodyBytes は状態変更API ( POST/PATCH ) のリクエストボディ上限 ( 1MB )。
// 無制限のjson.Decodeによるメモリ枯渇を防ぐ。超過時は413を返す。
const maxCommentBodyBytes = 1 << 20

// CommentsResponse は GET /api/comments のレスポンス。
type CommentsResponse struct {
	Comments []store.Comment `json:"comments"`
}

// decodeJSONBody はボディサイズを上限付きで読み取りJSONをdstにデコードする。
// 上限超過なら413、その他のデコード失敗なら400のレスポンスを書き込んでokにfalseを返す
// ( 呼び出し元はそのままreturnする )。
func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) (ok bool) {
	r.Body = http.MaxBytesReader(w, r.Body, maxCommentBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "Request Entity Too Large", http.StatusRequestEntityTooLarge)
			return false
		}
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return false
	}
	return true
}

// createCommentRequest は POST /api/comments のリクエストボディ。
type createCommentRequest struct {
	Path   string       `json:"path"`
	Anchor store.Anchor `json:"anchor"`
	Body   string       `json:"body"`
	Links  []string     `json:"links,omitempty"`
}

// updateCommentRequest は PATCH /api/comments/{id} のリクエストボディ。
// ポインタにすることで「キーが存在しない ( 更新しない )」と「false/空文字を指定 ( 更新する )」を区別する。
type updateCommentRequest struct {
	Body       *string           `json:"body,omitempty"`
	Resolved   *bool             `json:"resolved,omitempty"`
	NoteOffset *store.NoteOffset `json:"noteOffset"`
}

// maxNoteOffset は付箋オフセット (dx/dy) の絶対値上限。異常値によるUI破壊を防ぐため
// この範囲外の値は保存前にクランプする。
const maxNoteOffset = 20000

// clamp はvをmin..maxの範囲に収める。
func clamp(v, min, max float64) float64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

// commentIDPattern はコメントidとして許容する文字集合。
// ハイフンと16進文字のみを許可することで、パスセパレータ・ドット・スラッシュを
// 経路に含むIDを構造的に排除する ( トラバーサル対策 )。
var commentIDPattern = regexp.MustCompile(`^[0-9a-fA-F-]+$`)

func isValidCommentID(id string) bool {
	if id == "" || len(id) > 64 {
		return false
	}
	return commentIDPattern.MatchString(id)
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/files", s.handleFiles)
	mux.HandleFunc("GET /api/file", s.handleFile)
	mux.HandleFunc("GET /api/events", s.handleEvents)
	mux.HandleFunc("GET /api/comments", s.handleCommentsList)
	mux.HandleFunc("POST /api/comments", s.handleCommentsCreate)
	mux.HandleFunc("GET /api/comments/{id...}", s.handleCommentGet)
	mux.HandleFunc("PATCH /api/comments/{id...}", s.handleCommentUpdate)
	mux.HandleFunc("DELETE /api/comments/{id...}", s.handleCommentDelete)
	mux.HandleFunc("GET /raw/", s.handleRaw)
	mux.HandleFunc("GET /", s.handleSPA)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// DNS rebinding対策: Hostヘッダのホスト部が127.0.0.1/localhost/[::1]以外なら403を返す
		// ( 127.0.0.1バインドだけでは悪意あるWebサイト経由のブラウザリクエストを防げないため )
		if !isAllowedHost(r.Host) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		// http.ServeMuxは ".." を含むパスセグメントを検出すると、ハンドラを呼ぶ前に
		// クリーンパスへ307/301リダイレクトしてしまう ( notes..md 等は単一セグメント内の
		// 文字列でありcleanPathの対象外なので影響しない )。
		// トラバーサル試行がリダイレクトで隠れて403にならなくなるのを防ぐため、
		// 完全一致セグメントの ".." のみをここで検出して403にする。
		// ( 一律 strings.Contains(path, "..") ではなく、正当なファイル名の誤爆は避ける )
		// 実体的なトラバーサル防御自体はResolveSecurePathに一本化する。
		// ( /api/comments/{id} のidにも及ぶため、リテラルな ".." セグメントを含むid指定は
		//   コメントAPI固有のIDバリデーションより先にここで403になる。)
		if hasDotDotSegment(r.URL.Path) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		// CSRF対策: Originヘッダが存在するリクエストは、メソッドを問わず全て検証する
		// ( GET等の読み取り専用リクエストも対象。悪意あるページからのクロスオリジン
		// fetch/XHRでコメント内容等を読み取られるのを防ぐため )
		// Originヘッダが無いリクエスト ( curl・同一オリジンナビゲーション ) は許可する。
		if origin := r.Header.Get("Origin"); origin != "" && !isAllowedOrigin(origin) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		mux.ServeHTTP(w, r)
	})
}

// isAllowedOrigin はOriginヘッダの値が http://127.0.0.1[:port] / http://localhost[:port] /
// http://[::1][:port] のいずれかに一致するかどうかを判定する。
func isAllowedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if u.Scheme != "http" {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

// hasDotDotSegment はURLパスが ".." という完全一致のパスセグメントを含むかどうかを判定します。
// "notes..md" のような、セグメント内の文字列としての ".." は対象外です。
func hasDotDotSegment(urlPath string) bool {
	for _, seg := range strings.Split(urlPath, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// isAllowedHost はリクエストのHostヘッダが 127.0.0.1 / localhost / ::1 ( ポート部は任意 ) かどうかを判定します。
func isAllowedHost(host string) bool {
	if host == "" {
		return false
	}

	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}
	// IPv6のブラケット表記 ( 例: "[::1]" ) がポート無し形式で残るケースに対応
	hostname = strings.TrimPrefix(hostname, "[")
	hostname = strings.TrimSuffix(hostname, "]")

	switch hostname {
	case "127.0.0.1", "localhost", "::1":
		return true
	default:
		return false
	}
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	var files []FileEntry

	err := filepath.WalkDir(s.rootDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			// アクセス不能なエントリはスキップして一覧生成を継続する
			// ( 権限エラー等でファイル一覧全体が500にならないようにする )
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if fsutil.IsExcludedDir(name) {
				return filepath.SkipDir
			}
			return nil
		}

		rel, err := filepath.Rel(s.rootDir, p)
		if err != nil {
			return nil
		}
		// Windowsのパス区切りをスラッシュに変換
		relSlash := filepath.ToSlash(rel)

		ext := strings.ToLower(filepath.Ext(p))
		var fileType string
		switch ext {
		case ".md", ".markdown":
			fileType = "markdown"
		case ".html", ".htm":
			fileType = "html"
		default:
			return nil
		}

		files = append(files, FileEntry{
			Path: relSlash,
			Type: fileType,
		})
		return nil
	})

	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(FilesResponse{Files: files})
}

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		http.Error(w, "path parameter is required", http.StatusBadRequest)
		return
	}

	resolved, err := ResolveSecurePath(s.rootDir, relPath)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	content, err := os.ReadFile(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	ext := strings.ToLower(filepath.Ext(resolved))
	fileType := "unknown"
	switch ext {
	case ".md", ".markdown":
		fileType = "markdown"
	case ".html", ".htm":
		fileType = "html"
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(FileResponse{
		Path:    filepath.ToSlash(relPath),
		Type:    fileType,
		Content: string(content),
	})
}

func (s *Server) handleRaw(w http.ResponseWriter, r *http.Request) {
	// "/raw/" のプレフィックスを削除して相対パスを抽出
	relPath := strings.TrimPrefix(r.URL.Path, "/raw/")

	resolved, err := ResolveSecurePath(s.rootDir, relPath)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// ディレクトリへのアクセスは拒否
	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if info.IsDir() {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	http.ServeFile(w, r, resolved)
}

func (s *Server) handleSPA(w http.ResponseWriter, r *http.Request) {
	cleanPath := path.Clean(r.URL.Path)
	if cleanPath == "/" {
		cleanPath = "/index.html"
	}

	// fs.FSは先頭のスラッシュを嫌うので取り除く
	fsPath := strings.TrimPrefix(cleanPath, "/")

	f, err := s.subFS.Open(fsPath)
	if err == nil {
		f.Close()
		// ファイルが存在するので、標準の http.FileServer で配信
		http.FileServer(http.FS(s.subFS)).ServeHTTP(w, r)
		return
	}

	// ファイルが存在しない場合
	// 拡張子がないパスは index.html にフォールバックする
	base := path.Base(cleanPath)
	if !strings.Contains(base, ".") {
		indexContent, err := fs.ReadFile(s.subFS, "index.html")
		if err != nil {
			http.Error(w, "index.html not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexContent)
		return
	}

	// 拡張子があるのに存在しない場合は 404
	http.NotFound(w, r)
}

// resolveTargetPath はコメントAPIのpathパラメータをResolveSecurePathで検証する。
// 検証NGの場合はレスポンスを書き込んでokにfalseを返す ( 呼び出し元はそのままreturnする )。
func (s *Server) resolveTargetPath(w http.ResponseWriter, relPath string) (resolved string, ok bool) {
	resolved, err := ResolveSecurePath(s.rootDir, relPath)
	if err != nil {
		if errors.Is(err, ErrForbidden) {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return "", false
		}
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return "", false
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return "", false
	}
	return resolved, true
}

// handleCommentsList は GET /api/comments?path=<rel> を処理する。
func (s *Server) handleCommentsList(w http.ResponseWriter, r *http.Request) {
	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		http.Error(w, "path parameter is required", http.StatusBadRequest)
		return
	}

	if _, ok := s.resolveTargetPath(w, relPath); !ok {
		return
	}

	comments, err := s.store.List(filepath.ToSlash(relPath))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// コメント一覧は編集操作のたびに変わりうる ( ブラウザ/中間キャッシュによる古いデータの
	// 表示を防ぐ )。
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(CommentsResponse{Comments: comments})
}

// handleCommentsCreate は POST /api/comments を処理する。
func (s *Server) handleCommentsCreate(w http.ResponseWriter, r *http.Request) {
	var req createCommentRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	if req.Path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	if _, ok := s.resolveTargetPath(w, req.Path); !ok {
		return
	}
	if req.Body == "" {
		http.Error(w, "body is required", http.StatusBadRequest)
		return
	}
	// Anchor.Typeは ""(行アンカー) か "dom"(DOM要素アンカー) のみを許可する。
	// type=="dom" のときはselectorが要素を再解決するための必須情報なので、空なら拒否する。
	if req.Anchor.Type != "" && req.Anchor.Type != "dom" {
		http.Error(w, "anchor.type must be \"dom\" or omitted", http.StatusBadRequest)
		return
	}
	if req.Anchor.Type == "dom" && req.Anchor.Selector == "" {
		http.Error(w, "anchor.selector is required when anchor.type is \"dom\"", http.StatusBadRequest)
		return
	}

	created, err := s.store.Create(store.Comment{
		Path:   filepath.ToSlash(req.Path),
		Anchor: req.Anchor,
		Body:   req.Body,
		Links:  req.Links,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(created)
}

// handleCommentGet は GET /api/comments/{id} を処理する。
// 付箋リンク ( /#/comment/<id> ) からコメント単体を取得するために使う。
func (s *Server) handleCommentGet(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidCommentID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	c, err := s.store.Get(id)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// コメント単体も編集操作のたびに変わりうるため一覧同様にキャッシュさせない。
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(c)
}

// handleCommentUpdate は PATCH /api/comments/{id} を処理する。
// body/resolved/noteOffsetはリクエストJSONに存在するキーのみ更新する。
// noteOffsetのdx/dyはNaN/Infなら400、範囲外なら[-maxNoteOffset, maxNoteOffset]にクランプする。
func (s *Server) handleCommentUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidCommentID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	var req updateCommentRequest
	if !decodeJSONBody(w, r, &req) {
		return
	}

	var body string
	if req.Body != nil {
		body = *req.Body
	}
	var resolved bool
	if req.Resolved != nil {
		resolved = *req.Resolved
	}

	if req.NoteOffset != nil {
		if math.IsNaN(req.NoteOffset.DX) || math.IsInf(req.NoteOffset.DX, 0) ||
			math.IsNaN(req.NoteOffset.DY) || math.IsInf(req.NoteOffset.DY, 0) {
			http.Error(w, "noteOffset dx/dy must be finite numbers", http.StatusBadRequest)
			return
		}
		req.NoteOffset.DX = clamp(req.NoteOffset.DX, -maxNoteOffset, maxNoteOffset)
		req.NoteOffset.DY = clamp(req.NoteOffset.DY, -maxNoteOffset, maxNoteOffset)
	}

	updated, err := s.store.Update(id, body, resolved, req.NoteOffset, req.Body != nil, req.Resolved != nil, req.NoteOffset != nil)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(updated)
}

// handleCommentDelete は DELETE /api/comments/{id} を処理する。
func (s *Server) handleCommentDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isValidCommentID(id) {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return
	}

	if err := s.store.Delete(id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
