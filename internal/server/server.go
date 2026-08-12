package server

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"mdmiel/internal/auth"
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
	logger              *slog.Logger // NewServerで必ず設定される ( 既定は slog.Default() )
	authMW              auth.Middleware
	editorScheme        string // NewServerで必ず設定される ( 既定は defaultEditorScheme )
}

// defaultEditorScheme は「エディタで開く」に使うURLスキームの既定値。
const defaultEditorScheme = "vscode"

// editorSchemePattern はURLスキームとして受け付ける文字種。RFC 3986 のスキーム文法に
// 合わせて先頭を英字に限り、以降は英数字とハイフンだけを許す。"://" やスラッシュ入りの
// 値はここで弾かれる。RFC が許す "+" と "." は意図的に落としてある ( vscode /
// vscode-insiders / cursor はこの範囲に収まるため、実用上の不足は今のところ無い )。
var editorSchemePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]*$`)

// deniedEditorSchemes はブラウザが自前で解釈するスキーム。生成したURLはフロントの
// アンカーの href に入るため、javascript: のようにページ内でコードが動くものや、
// 意図せぬネットワーク送信を招くものは文字種の検査とは別に名指しで拒否する。
// 設定するのは利用者自身だが、誤設定が「ファイル名にJavaScriptを仕込める」状態に
// 直結するため、fail-closedにしておく。
var deniedEditorSchemes = map[string]bool{
	"javascript": true,
	"vbscript":   true,
	"data":       true,
	"blob":       true,
	"file":       true,
	"http":       true,
	"https":      true,
	"about":      true,
	"ws":         true,
	"wss":        true,
}

// Option は NewServer の任意設定。検証が必要な設定 ( 将来の認証・公開Origin等 ) を
// 追加できるよう error を返す形にしてある。
type Option func(*Server) error

// WithLogger は構造化ログの出力先を注入する。未指定なら slog.Default() を使う。
func WithLogger(l *slog.Logger) Option {
	return func(s *Server) error {
		if l == nil {
			return errors.New("WithLogger: logger must not be nil")
		}
		s.logger = l
		return nil
	}
}

// WithAuth は認証ミドルウェアを mux の手前に差し込む。
// ミドルウェアは非nilのhttp.Handlerを返さなければならない。
func WithAuth(mw auth.Middleware) Option {
	return func(s *Server) error {
		if mw == nil {
			return errors.New("WithAuth: middleware must not be nil")
		}
		s.authMW = mw
		return nil
	}
}

// WithEditorScheme は「エディタで開く」のURLスキームを差し替える ( 既定は "vscode" )。
// 空文字・英数字とハイフン以外を含む値・先頭が英字でない値・ブラウザが自前で解釈する
// スキームは error で弾く。
func WithEditorScheme(scheme string) Option {
	return func(s *Server) error {
		if !editorSchemePattern.MatchString(scheme) {
			return fmt.Errorf("WithEditorScheme: invalid scheme %q (must start with a letter; allowed: letters, digits, hyphen)", scheme)
		}
		if deniedEditorSchemes[strings.ToLower(scheme)] {
			return fmt.Errorf("WithEditorScheme: scheme %q is handled by the browser and must not be used", scheme)
		}
		s.editorScheme = scheme
		return nil
	}
}

// NewServer はrootDir配下を配信するmdmielサーバーを作る。
// stは行コメントの永続化先 ( 通常はstore.NewFileStore(rootDir) ) を注入する。
func NewServer(rootDir string, webDist embed.FS, st store.Store, opts ...Option) (*Server, error) {
	subFS, err := fs.Sub(webDist, "dist")
	if err != nil {
		return nil, err
	}
	s := &Server{
		rootDir: rootDir,
		webDist: webDist,
		subFS:   subFS,
		store:   st,
		hub:     newEventHub(),
		logger:  slog.Default(),

		editorScheme: defaultEditorScheme,
	}
	for _, opt := range opts {
		if opt == nil {
			return nil, errors.New("server: nil option")
		}
		if err := opt(s); err != nil {
			return nil, fmt.Errorf("server: apply option: %w", err)
		}
	}
	return s, nil
}

// internalError は500応答を返す。ボディには定型文だけを書き、元のエラー
// ( rootDirの絶対パス等のOS情報を含みうる ) はログにのみ出力する。
func (s *Server) internalError(w http.ResponseWriter, r *http.Request, err error) {
	s.logger.ErrorContext(r.Context(), "request failed",
		"method", r.Method,
		"path", r.URL.Path,
		"err", err)
	http.Error(w, "Internal Server Error", http.StatusInternalServerError)
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

// FilesResponse の Root は「エディタで開く」用のrootDir絶対パスを、URLに載せられるよう
// 区切りをスラッシュへ揃えたもの ( filepath.ToSlash )。変換をサーバー側で行うのは実行OSを
// 知っているのがサーバーだけだからで、フロントで一律に "\" を "/" へ潰すとPOSIXの正当な
// ファイル名 ( ディレクトリ名に "\" を含むもの ) を壊す。WindowsのUNC ( \\server\share )
// は先頭の "//" として残るため、フロント側で先頭スラッシュを削ってはならない。
// OSユーザー名を含みうるためローカル起動時にしか返してはならず、公開構成では空にする。
// 判定をサーバー側に置くのは、フロントで出し分けてもサーバーが絶対パスを返した時点で
// すでに漏れているため。Rootが空のときフロントは「開く」ボタンを描画しない。
type FilesResponse struct {
	Files        []FileEntry `json:"files"`
	Root         string      `json:"root"`
	EditorScheme string      `json:"editorScheme"`
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

type serverRoute struct {
	pattern string
	handler func(*Server, http.ResponseWriter, *http.Request)
}

// serverRoutes は Handler が mux に登録する全ルートの定義元。
var serverRoutes = []serverRoute{
	{pattern: "GET /api/files", handler: (*Server).handleFiles},
	{pattern: "GET /api/file", handler: (*Server).handleFile},
	{pattern: "GET /api/events", handler: (*Server).handleEvents},
	{pattern: "GET /api/comments", handler: (*Server).handleCommentsList},
	{pattern: "POST /api/comments", handler: (*Server).handleCommentsCreate},
	{pattern: "GET /api/comments/{id...}", handler: (*Server).handleCommentGet},
	{pattern: "PATCH /api/comments/{id...}", handler: (*Server).handleCommentUpdate},
	{pattern: "DELETE /api/comments/{id...}", handler: (*Server).handleCommentDelete},
	{pattern: "GET /raw/", handler: (*Server).handleRaw},
	{pattern: "GET /", handler: (*Server).handleSPA},
}

// Handler はHTTPハンドラを返す。呼び出しごとにmuxと認証ミドルウェアを構築する。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	for i := range serverRoutes {
		route := &serverRoutes[i]
		mux.HandleFunc(route.pattern, func(w http.ResponseWriter, r *http.Request) {
			route.handler(s, w, r)
		})
	}

	var handler http.Handler = mux
	if s.authMW != nil {
		handler = s.authMW(handler)
		if handler == nil {
			panic("server: auth middleware returned a nil handler")
		}
	}

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

		handler.ServeHTTP(w, r)
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
		// walk関数はSkipDirかnilしか返さないため、現状この分岐には到達しない。
		s.internalError(w, r, err)
		return
	}

	// TODO(PR-C): publicOrigin が非nilなら Root を空にする。現時点では main.go に
	// --listen も認証も無く公開経路自体が存在しないため、常に絶対パスを返している。
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(FilesResponse{
		Files:        files,
		Root:         filepath.ToSlash(s.rootDir),
		EditorScheme: s.editorScheme,
	})
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
		s.internalError(w, r, err)
		return
	}

	content, err := os.ReadFile(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		s.internalError(w, r, err)
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
		s.internalError(w, r, err)
		return
	}

	// ディレクトリへのアクセスは拒否
	info, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return
		}
		s.internalError(w, r, err)
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
//
// ResolveSecurePathは存在しないパスでも境界が安全なら解決済みパスを返すため、
// 「実在するファイルにのみコメントを許可する」条件はここで明示的に担保する。
func (s *Server) resolveTargetPath(w http.ResponseWriter, r *http.Request, relPath string) (resolved string, ok bool) {
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
		s.internalError(w, r, err)
		return "", false
	}

	if _, err := os.Stat(resolved); err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "Not Found", http.StatusNotFound)
			return "", false
		}
		s.internalError(w, r, err)
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

	if _, ok := s.resolveTargetPath(w, r, relPath); !ok {
		return
	}

	comments, err := s.store.List(filepath.ToSlash(relPath))
	if err != nil {
		s.internalError(w, r, err)
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

	var author string
	if u, ok := auth.UserFrom(r.Context()); ok {
		author = u.DisplayName()
	} else if s.authMW != nil {
		s.internalError(w, r, errors.New("authenticated request has no user"))
		return
	}

	if req.Path == "" {
		http.Error(w, "path is required", http.StatusBadRequest)
		return
	}
	if _, ok := s.resolveTargetPath(w, r, req.Path); !ok {
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
		Author: author,
		Links:  req.Links,
	})
	if err != nil {
		s.internalError(w, r, err)
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
		s.internalError(w, r, err)
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
		s.internalError(w, r, err)
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
		s.internalError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
