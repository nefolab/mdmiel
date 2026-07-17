# 05. HTTPサーバーとAPI — internal/server/server.go ( 540行 )

`Server` structとそのHandler()、ファイル一覧・本文取得・コメントCRUDの各APIハンドラ、そしてSPA配信をまとめて読む。540行あるため全文は載せず、要所を抜粋する形で進める。

この章のゴール。

- Go 1.22+のメソッド付きルーティングパターン ( `mux.HandleFunc("GET /api/files", ...)` ) と `{id...}` ワイルドカードの意味を説明できる
- `Handler()` が返すラップ関数がミドルウェアとして何を検証しているか、04章のパス対策とどう役割分担しているか説明できる
- ポインタフィールドを持つリクエスト構造体 ( `updateCommentRequest` ) が、02章のStore interfaceのboolフラグ群にどう変換されるか追える

## 1. NewServerとHandler(): ルーティング

```go
type Server struct {
	rootDir string
	webDist embed.FS
	subFS   fs.FS
	store   store.Store
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
	}, nil
}
```

```go
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/files", s.handleFiles)
	mux.HandleFunc("GET /api/file", s.handleFile)
	mux.HandleFunc("GET /api/comments", s.handleCommentsList)
	mux.HandleFunc("POST /api/comments", s.handleCommentsCreate)
	mux.HandleFunc("PATCH /api/comments/{id...}", s.handleCommentUpdate)
	mux.HandleFunc("DELETE /api/comments/{id...}", s.handleCommentDelete)
	mux.HandleFunc("GET /raw/", s.handleRaw)
	mux.HandleFunc("GET /", s.handleSPA)
```

読みどころ。

- `Server` structが `store store.Store` というinterface型でフィールドを持っている。01章で見た `server.NewServer(absDir, web.Dist, fileStore)` の第3引数がここに入る。ServerはFileStoreの存在を知らず、Store interfaceのメソッドだけを呼ぶ
- `fs.Sub(webDist, "dist")` は埋め込みFS ( `web.Dist`、06章で詳しく扱う ) から `dist/` サブディレクトリだけを切り出した `fs.FS` を作る。`go:embed all:dist` で埋め込むとパスに `dist/` プレフィックスが残ったままになるため、`index.html` を素直な相対パスで開けるようにこの一段が要る
- `mux.HandleFunc("GET /api/files", ...)` のようにメソッド名をパターン文字列の先頭に書けるのは、Go 1.22で `net/http` の `ServeMux` に追加されたルーティング機能。以前は自前でメソッド判定を書くか、外部ルーターライブラリ ( gorilla/mux等 ) を使う必要があったが、これにより標準ライブラリだけでメソッド別ルーティングが書ける ( 依存ゼロ方針を後押しした変更 )
- `"PATCH /api/comments/{id...}"` の `{id...}` はワイルドカードパターン。`{id}` ( 3点リーダ無し ) だと1セグメントしかマッチしないが、`{id...}` は残り全部 ( スラッシュを含む ) をマッチさせる。idは本来1セグメントの想定だが、あえて `...` にしているのは、`/api/comments/../etc` のようにidの位置に複数セグメントのトラバーサル文字列が来たケースも同じハンドラに到達させ、2節の `hasDotDotSegment` や `isValidCommentID` で一律に弾くため ( 変にマッチせず404になって素通りする方が、挙動として分かりにくい )

## 2. Handler()が返すラップ関数 = ミドルウェア

```go
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

		// CSRF対策: 状態変更メソッド ( POST/PATCH/DELETE ) のみOriginヘッダを検証する。
		// Originヘッダが無いリクエスト ( curl・同一オリジンナビゲーション ) は許可する。
		switch r.Method {
		case http.MethodPost, http.MethodPatch, http.MethodDelete:
			if origin := r.Header.Get("Origin"); origin != "" && !isAllowedOrigin(origin) {
				http.Error(w, "Forbidden", http.StatusForbidden)
				return
			}
		}

		mux.ServeHTTP(w, r)
	})
}
```

```go
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
```

読みどころ。

- `Handler()` は `mux` ( ルーティング本体 ) をそのまま返さず、`http.HandlerFunc(func(w, r) {...})` でラップして返している。このラップ関数がリクエストを `mux.ServeHTTP` に渡す前に共通チェックを差し込む、いわゆるミドルウェアの形。Goには専用のミドルウェア構文が無く、「`http.Handler` を受け取って別の `http.Handler` を返す関数」という素朴な合成で表現するのが標準的なやり方
- `isAllowedHost` によるDNSリバインディング対策は04章のパストラバーサル対策とは狙いが違う多層防御。127.0.0.1バインドはOSレベルで「外部マシンから直接繋がせない」ためのものだが、悪意あるWebサイトを開いたブラウザ自体は `127.0.0.1` 宛にリクエストを送れてしまう ( DNSリバインディング攻撃はこれを悪用し、リクエストのHostヘッダを騙る )。Hostヘッダを検証することで、そうした偽装リクエストも弾く
- `hasDotDotSegment` のコメントが詳しい。`http.ServeMux` は `..` を含むURLパスを見つけると、ハンドラを呼ぶ前に307/301でクリーンなパスへリダイレクトしてしまう仕様がある。もしこの一手間が無いと、トラバーサル試行がリダイレクト経由で「403にならないまま」別の URLへ流れてしまう恐れがある。ここで先回りして完全一致セグメントの `".."` だけを検出し、リダイレクトが起きる前に403で止めている。実体的な防御は04章の `ResolveSecurePath` に一本化されており、ここはあくまで「リダイレクトに隠れて防御が素通りされない」ための保険
- CSRF対策は状態変更メソッド ( POST/PATCH/DELETE ) だけを対象にし、Originヘッダが無いリクエストは許可している。curlや同一オリジンからの通常ナビゲーションはOriginを送らないことが多いため、これらを弾かないための設計判断。Originが「送られてきた場合」にだけそれが許可リストと一致するか検証する非対称なチェックになっている
- `isAllowedOrigin` / `isAllowedHost` はどちらも `127.0.0.1` / `localhost` / `::1` のみを許可するホワイトリスト方式。`net.SplitHostPort` でポート部を切り離してからホスト名だけを比較しており、`127.0.0.1:8686` のようにポート付きで来るHostヘッダにも対応する

## 3. handleFiles: ファイル一覧のWalkDir

```go
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
			if strings.HasPrefix(name, ".") || name == "node_modules" || name == ".mdmiel" {
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
```

読みどころ。

- `filepath.WalkDir(root, fn)` はrootディレクトリを再帰的に走査し、見つけたエントリ ( ファイル・ディレクトリ ) ごとにコールバック `fn` を呼ぶ。コールバックが `filepath.SkipDir` を返すと、そのディレクトリの中身は走査せずスキップする。ここでは2箇所でこの戻り値を使い分けている。1つはアクセス不能なディレクトリに遭遇したときの防御的スキップ、もう1つは隠しディレクトリ・`node_modules`・`.mdmiel` を意図的に除外するためのスキップ
- `strings.HasPrefix(name, ".") || name == "node_modules" || name == ".mdmiel"` で隠しディレクトリを除外している。`.mdmiel` は `.` で始まるので実は最初の条件だけで既に該当するが、「コメント保存用ディレクトリは一覧に出さない」という意図を読み手に明示するためあえて条件を分けて書いてある
- 拡張子フィルタは `switch ext { case ".md", ".markdown": ...; case ".html", ".htm": ...; default: return nil }` という形。Goのswitchはcaseごとにカンマ区切りで複数値を書け、どれにも当たらなければ `default` に落ちる。ここでは対象外拡張子のファイルを `return nil` ( エラーではなく「このエントリは一覧に含めない」の意 ) で読み飛ばしている
- `filepath.ToSlash(rel)` はWindowsの `\` 区切りパスを `/` 区切りに変換する。フロントエンドに返すJSONのpathはOSに依存せず常にスラッシュ区切りに統一しておくことで、`GET /api/file?path=...` のクエリパラメータもスラッシュ前提で扱える

## 4. コメントAPI: リクエストのデコードとバリデーション

```go
// maxCommentBodyBytes は状態変更API ( POST/PATCH ) のリクエストボディ上限 ( 1MB )。
// 無制限のjson.Decodeによるメモリ枯渇を防ぐ。超過時は413を返す。
const maxCommentBodyBytes = 1 << 20

// ...

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

// ...

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
```

```go
	updated, err := s.store.Update(id, body, resolved, req.NoteOffset, req.Body != nil, req.Resolved != nil, req.NoteOffset != nil)
```

読みどころ。

- `decodeJSONBody` は `http.MaxBytesReader` でリクエストボディの読み取り上限を1MBに絞ってからデコードしている。上限が無いと、巨大なボディを送りつけられてメモリを食い潰される攻撃 ( リソース枯渇 ) が可能になる。`errors.As(err, &maxErr)` で「上限超過によるエラー」だけを型判定し、413 ( Request Entity Too Large ) を返す。それ以外のデコード失敗は400として扱う
- `updateCommentRequest` の3フィールドが全てポインタ ( `*string` / `*bool` / `*store.NoteOffset` ) になっているのは、02章のStore interfaceで見た `updateBody bool, updateResolved bool, updateOffset bool` という3つのフラグの発生源。JSONに `"resolved": false` というキーが明示的に来た場合と、キー自体が無い場合とでは、Goの `*bool` は前者が `&false` ( 非nil )、後者が `nil` になり区別できる。値型 `bool` のままだと両方とも `false` になってしまい区別が付かない
- 最後の抜粋 `s.store.Update(id, body, resolved, req.NoteOffset, req.Body != nil, req.Resolved != nil, req.NoteOffset != nil)` が、ポインタのnil/非nilを02章のboolフラグへ変換している実物。`req.Body != nil` がそのまま `updateBody` になり、`body` ( ポインタを剥がした後の値、nilなら型のゼロ値 ) と組み合わせてStoreに渡される。フロントエンドのポインタ表現 → HTTP JSON → サーバーのポインタ表現 → Store層のboolフラグ、という変換の連鎖がここで完結する
- `isValidCommentID` は `{id...}` ワイルドカードで受け取ったidを、ハイフンと16進文字だけの正規表現でホワイトリスト検証している。IDはFileStore側で `id+".json"` としてそのままファイルパスに組み込まれる ( 03章 ) ため、`/` や `..` を含むIDが通ってしまうとパストラバーサルになりかねない。正規表現で使える文字種を最初から絞ることで、そもそもそうした文字を含むIDが後段に届かないようにしている
- `clamp` は付箋のドラッグオフセット ( dx/dy ) が異常に大きい値でも `[-maxNoteOffset, maxNoteOffset]` に丸め込む。フロントエンドのバグや悪意あるリクエストで極端な値が送られても、UIが壊れない範囲に収める防御的な一手間

## 5. embed.FSとSPA配信

```go
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
```

```go
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
```

読みどころ。

- `web/embed.go` はわずか3行だが、mdmielが単一バイナリで配布できる理由そのもの。`//go:embed all:dist` はGoコンパイラに対する指示コメントで、`go build` 時に `web/dist/` 配下の全ファイル ( `all:` プレフィックスがドットファイルも含めることを保証する ) を `embed.FS` 型の変数 `Dist` へバイナリごと埋め込ませる。実行時にファイルシステムを読みに行く必要が無くなる
- `handleSPA` はReact Router ( クライアントサイドルーティング ) を前提としたSPA配信の定番パターン。まずリクエストされたパスが `subFS` ( 1節の `fs.Sub` で切り出したdist直下 ) に実ファイルとして存在するか `Open` で確認し、存在すれば `http.FileServer` にそのまま委譲する ( JS/CSS/画像などの静的アセット )
- ファイルが存在しない場合、パスの最後のセグメントに `.` が無ければ ( = 拡張子が無いパスなら ) `index.html` の内容をそのまま返す。これによりReact Router側が管理する任意のクライアントサイドルート ( 例えば将来 `/settings` のようなパスを足しても ) がサーバー側の404にならず、SPAのエントリポイントへフォールバックする。拡張子があるのに存在しない場合 ( `/foo.js` が無い等 ) は素直に404を返し、フォールバックしない
- `s.subFS.Open(fsPath)` を呼んだ直後に `f.Close()` だけして中身は使わず、改めて `http.FileServer(http.FS(s.subFS)).ServeHTTP(w, r)` で配信し直しているのは一見遠回りだが、「存在確認」と「実際の配信 ( Range対応・Content-Type推定・キャッシュヘッダ等 )」の責務を分けている。`http.FileServer` が持つ機能をフォールバック判定のために自前実装せずに済む

## 6. server_test.goに見るhttptestの使い方

```go
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
```

読みどころ。

- `net/http/httptest` は実際にポートを開かずに `http.Handler` をテストするための標準パッケージ。`httptest.NewRequest` で `*http.Request` を、`httptest.NewRecorder` でレスポンスを受け止める `*httptest.ResponseRecorder` ( `http.ResponseWriter` を満たす ) を作り、`handler.ServeHTTP(rec, req)` を直接呼ぶだけでハンドラの挙動を検証できる。実サーバーの起動・停止が要らないぶんテストが高速
- `req.Host = "127.0.0.1:8686"` を明示しているのはこの章の2節と直結する。`httptest.NewRequest` が作るデフォルトのHostは `example.com` で、2節の `isAllowedHost` に弾かれて全リクエストが403になってしまう。テストコードのこの1行が無いと、テストしたいハンドラの中身にたどり着く前にミドルウェアで落ちる
- テストはトップレベルの `TestServer` の中で `t.Run("GET /api/files", func(t *testing.T) {...})` のようにサブテストへ分割されている。04章のテーブル駆動テストとは違うアプローチだが、狙いは同じで「1つのAPIエンドポイントに対する一連の検証」を独立した単位として実行・報告できるようにしている

疑問はこのファイルの該当行に付箋で。次は06章、フロントエンド概観へ。
