# 07. 認証の差し込み口 — internal/auth ( 61行 ) + internal/server/server.go の認証部分

mdmielは「ローカル専用ツール」として作られている。それを社内サーバーに置いて複数人で使いたくなったとき、本体をどう変えるべきか。この章はその答えとして入った「差し込み口 ( seam ) 」を読む。

ここで読むコードには特徴がある。認証を実装していない。ログインフォームもパスワード照合もセッション管理も無い。あるのは「認証を外から差し込むための穴」と「差し込まれた認証の結果を受け取る作法」だけ。なぜそうしたのかが、この章のいちばんの読みどころになる。

この章のゴール。

- 本体が認証方式を持たず差し込み口だけを提供する理由を説明できる
- `Middleware` がinterfaceではなく型エイリアスである理由を説明できる
- contextで認証済みIDを運ぶ仕組みと、それがコメントの `author` へ繋がる経路を追える
- ミドルウェアの積層順が「どこに置くか」ではなく「何を守るか」で決まっていることを読み取れる
- テストが通ることと、テストが契約を守れていることの違いを説明できる

## 1. なぜ本体が認証方式を持たないのか

mdmielの想定利用者は、社内でこれをforkして自社の認証基盤 ( EntraID、Google Workspace、社内OIDC ) に繋ぐ人たちだ。ここで本体が特定の認証方式を実装してしまうと、次のどちらかが起きる。

- 本体がEntraIDを実装する → 他の認証基盤の人が使えない。かといって全方式をサポートすると本体が肥大化し、ローカル利用者が使わないコードの保守を背負う
- 本体が抽象的な「認証設定」を持つ → 方式ごとに必要な設定項目が違うので、抽象が破綻するか、設定が何でも入る箱になる

そこで本体は「認証を差し込める形」だけを定義し、方式そのものはfork先の責務にした。本体に入るのはリファレンス実装としてのBasic認証1つだけで、これも「差し込み口の使用例」という位置づけになる ( Basic認証の実装はまだ入っておらず、後続の作業で入る )。

この判断のもう一つの効果として、ローカル利用者にとっては何も変わらない。認証を差し込まなければ、リクエストの通り道はこれまでと1バイトも変わらない。

## 2. Middlewareは型エイリアス — interfaceにしなかった理由

```go
// Package auth は認証の差し込み口を提供する。
// mdmiel本体は認証方式を持たず、認証ミドルウェアを外から差し込む。
package auth

// Middleware は認証の差し込み口。
type Middleware = func(http.Handler) http.Handler
```

Goでこういう拡張点を作るとき、最初に思いつくのはinterfaceだ。たとえばこうなる。

```go
// 採用しなかった案
type Authenticator interface {
    Authenticate(r *http.Request) (User, error)
}
```

一見きれいだが、これは破綻する。認証はレスポンスを書く必要がある処理だからだ。

- Basic認証は未認証時に `401` と `WWW-Authenticate: Basic realm="..."` ヘッダを返す
- OIDCは未認証時にIdPへ `302` リダイレクトし、戻ってきたら `Set-Cookie` でセッションを張る

`Authenticate(r) (User, error)` は `http.ResponseWriter` を受け取らないので、これらが何ひとつ書けない。「ヘッダを見てユーザーを判定するだけ」の認証にしか使えず、fork先の本命であるOIDCで詰む。

対して `func(http.Handler) http.Handler` は、`ServeHTTP` の中で好きなだけレスポンスを書ける。しかもGoの標準ライブラリやサードパーティのミドルウェアが全部この形をしているので、既存資産をそのまま渡せる。

読みどころ。

- `type Middleware = func(...)` の `=` に注目。これは型定義 ( `type Middleware func(...)` ) ではなく型エイリアス。エイリアスにすると `Middleware` と `func(http.Handler) http.Handler` が完全に同じ型になり、fork先は素の関数をそのまま渡せて変換が要らない。型定義にすると代入互換ではあるが別の型になり、他所のライブラリが返すミドルウェアを渡すときに明示的な変換が挟まる
- 抽象の選択には方向がある。ミドルウェアという広い形にしておけば、「ヘッダを見るだけ」の狭い抽象が欲しいfork先は自分でそれを書いて包める。逆にinterfaceという狭い形で固定すると、レスポンスを書きたいfork先は本体を書き換えるしかない。迷ったら「後から狭められるほう」を選ぶ

## 3. contextで認証済みIDを運ぶ

本体とミドルウェアの契約は、認証済みIDの受け渡しだけだ。それをcontext経由で行う。

```go
// User は認証済みID。
type User struct {
	ID   string
	Name string
}

// DisplayName は表示名を返す。Name が空の場合は ID を返す。
func (u User) DisplayName() string {
	if u.Name != "" {
		return u.Name
	}
	return u.ID
}

type userCtxKey struct{}

// WithUser は認証済みIDをcontextに載せる。
func WithUser(ctx context.Context, u User) context.Context {
	return context.WithValue(ctx, userCtxKey{}, u)
}

// UserFrom はcontextから認証済みIDを取り出す。
// 未設定またはIDが空のUserは未認証として扱い、ok=falseを返す。
func UserFrom(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userCtxKey{}).(User)
	if !ok || u.ID == "" {
		return User{}, false
	}
	return u, true
}
```

読みどころ。

- `type userCtxKey struct{}` は中身の無い構造体で、これをcontextのキーに使うのがGoの定番作法。`context.WithValue(ctx, "user", u)` のように文字列をキーにすると、別のパッケージがたまたま同じ文字列を使ったときに値が衝突する。空構造体の型はパッケージごとに固有なので、衝突が構造的に起こりえない。しかも `userCtxKey` は小文字始まり = 非公開なので、パッケージ外から同じキーを作ることもできない。結果として「認証ミドルウェア以外がUserを偽装して載せる」経路が塞がれる
- `struct{}` はサイズ0なので、キーとして使ってもメモリを消費しない
- `UserFrom` が `ok` の判定に `u.ID == ""` を含めているのが要点。「contextに載ってはいるがIDが空のUser」を未認証として扱う。これは7節で効いてくる。ミドルウェアが半端に埋めた値を、呼び出し側が `ok` を見るだけで排除できる
- `DisplayName()` は値レシーバ ( `u User` ) のメソッド。`User` は2つの文字列だけの小さな値型なのでコピーが安く、ポインタレシーバにする理由が無い

## 4. IsLoopbackAddr: 何も解決しない判定

```go
// IsLoopbackAddr はIPリテラルのバインドアドレスがループバックかを判定する。
// DNS解決は行わず、解析できない入力はすべてfalseを返すfail-closedな判定である。
// IPv4-mapped IPv6は、netip.Addr.IsLoopbackが埋め込まれたIPv4の127/8を
// ループバックとして判定するため、ループバックとして扱う。
func IsLoopbackAddr(addr string) bool {
	if addrPort, err := netip.ParseAddrPort(addr); err == nil {
		return addrPort.Addr().IsLoopback()
	}

	host := addr
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.IsLoopback()
}
```

この関数は、後続の作業で `cmd/mdmiel/main.go` が使う。「ループバック以外にバインドしようとしているのに認証が設定されていなければ、起動せずに終了する」という安全弁の判定材料になる。

読みどころ。

- ホスト名を名前解決しない。`localhost` を渡しても `false` が返る。一見不便だが、これは意図的な設計判断。名前解決すると、解決結果が起動後に変わりうる ( DNSのTOCTOU ) 。判定を純粋な文字列解析に閉じ込めることで、起動時の判定と実際のバインド先がずれる余地を無くしている。`localhost` と書きたい利用者は `127.0.0.1` と書けばよく、行き止まりにはならない
- 解析できない入力をすべて `false` に倒すのがfail-closedの発想。`false` = 「ループバックではない」= 「認証が必須」という安全側の結論になる。もし逆に倒すと、解析できない入力で認証チェックがすり抜ける。セキュリティに関わる判定では、迷ったら厳しいほうへ倒す
- `net.IP` ( 旧来の型 ) ではなく `netip.Addr` を使っている。`netip.Addr` はGo 1.18で入った新しいIPアドレス型で、値型なのでアロケーションが無く、比較可能 ( `==` が使える ) 。新規コードではこちらが推奨される
- `netip.ParseAddrPort` を先に試し、失敗したらブラケットを剥がして `netip.ParseAddr` を試す2段構え。`127.0.0.1:8686` のようなポート付きと、`::1` のようなポート無しの両方を受けるため

## 5. WithAuth: Optionパターンによる注入

05章で見た `NewServer` は可変長引数で `Option` を受け取る。認証もこの列に乗る。

```go
// Option は NewServer の任意設定。検証が必要な設定 ( 将来の認証・公開Origin等 ) を
// 追加できるよう error を返す形にしてある。
type Option func(*Server) error

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
```

読みどころ。

- `Option` が `error` を返す形になっているのが効いている。設定値の検証をOption自身に閉じ込められるため、`NewServer` に検証ロジックが溜まらない。この形は先行するログ基盤の作業で入ったもので、認証はそこにそのまま乗っただけ。既存の `NewServer` 呼び出し8箇所は1文字も変えずに済んでいる
- `mw == nil` をエラーにしているので、「認証なし」はOptionを渡さないことで表現する。`WithAuth(nil)` と「Optionを渡さない」の2通りで同じ状態を作れてしまうと、どちらが正しい書き方か迷う。表現を1つに絞るのは設計の作法
- 関数型の `nil` 判定であることに注意。`Middleware` は型エイリアスなので、interfaceにありがちな「型情報を持ったnil ( typed nil ) が非nil扱いになる」問題は起きない
- `Server` に増えたフィールドは `authMW auth.Middleware` の1本だけ。nilなら認証なし、非nilなら認証あり、という素直な表現になっている

## 6. Handler()のどこに差し込むか

```go
type serverRoute struct {
	pattern string
	handler func(*Server, http.ResponseWriter, *http.Request)
}

// serverRoutes は Handler が mux に登録する全ルートの定義元。
var serverRoutes = []serverRoute{
	{pattern: "GET /api/files", handler: (*Server).handleFiles},
	{pattern: "GET /api/file", handler: (*Server).handleFile},
	{pattern: "GET /api/events", handler: (*Server).handleEvents},
	// ...
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
		// Hostチェック ( DNS rebinding対策 ) → 403
		// ".."セグメントチェック → 403
		// Originチェック ( CSRF対策 ) → 403
		handler.ServeHTTP(w, r)
	})
}
```

リクエストが通る順序はこうなる。

```
Host検証 → ".."検証 → Origin検証 → 認証 → mux → 各ハンドラ
```

読みどころ。

- 認証が3つのガードより内側にある。これは「認証は最初にやるもの」という直感に反するので、理由が要る。Host偽装や不正Originのリクエストは、認証情報が正しく付いていても403で落とすのが正しい。もし認証を外側に置くと、サーバーが既に拒否すると決めたリクエストに対してOIDCミドルウェアが動き、Cookieを発行し、ワンタイムのstateを消費し、IdPへリダイレクトしてしまう。攻撃者に副作用を起こさせないため、門前払いを先にする
- 逆に認証はmuxより外側にある。これによりミドルウェアは任意のパスを自前で処理できる。OIDCが必要とする `/auth/callback` のようなエンドポイントを、本体のルート定義に手を入れずfork側だけで生やせる。muxより内側だと、catch-allの `GET /` ( SPA配信 ) に食われてしまう
- ミドルウェアがnilの `http.Handler` を返したらpanicさせている。ここで素の `mux` にフォールバックする実装にしてはいけない。認証が丸ごと無効になった状態で全ルートが公開されるからだ。安全に倒せない状況では、静かに動き続けるより落ちるほうがよい ( `net/http` 自身も `mux.Handle` にnilハンドラを渡すとpanicする )
- ルート定義が `serverRoutes` というパッケージ変数に切り出されている。05章の時点ではこれらは `Handler()` の中に直接並んでいた。テストが「実際に登録されているルート」を数えられるようにするための変更で、理由は8節で読む
- `(*Server).handleFiles` という書き方はメソッド式 ( method expression ) 。メソッドを「レシーバを第1引数に取る普通の関数」に変換する構文で、`func(*Server, http.ResponseWriter, *http.Request)` 型の値になる。`s.handleFiles` ( メソッド値 ) だと特定の `s` に束縛されてしまうため、パッケージ変数として先に定義しておくにはメソッド式が要る

## 7. authorへの接続 — 静かな誤記録を作らない

認証済みIDは、コメントの `author` フィールドに繋がる。

```go
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

	// ...バリデーション...

	created, err := s.store.Create(store.Comment{
		Path:   filepath.ToSlash(req.Path),
		Anchor: req.Anchor,
		Body:   req.Body,
		Author: author,
		Links:  req.Links,
	})
```

分岐は3通りある。

| contextのUser | 認証ミドルウェア | 結果 |
|---|---|---|
| あり | あり / なし | `DisplayName()` をauthorにする |
| なし | なし | authorは空。03章の `currentOSUser()` がOSユーザー名で補完する ( ローカルの既存挙動 ) |
| なし | あり | 500を返して中断する |

読みどころ。

- 3行目の分岐 ( 認証ありなのにUserが無い ) が500なのは、ミドルウェアの実装ミスを静かに握り潰さないため。ここで素通りさせると `author` が空のままFileStoreに届き、03章で見た「空ならOSユーザー名で補完する」ロジックが発火する。つまり社内サーバーで動かしているmdmielが、全員のコメントを「サーバープロセスを起動したOSユーザーの名前」で記録してしまう。しかもエラーは何も出ないので、誰も気づかないまま記録が汚染される。壊れた状態で動き続けるより、明示的に落ちるほうがよい
- 1行目が `s.authMW` を見ずに `UserFrom` の結果だけで判断しているのがポイント。当初の設計は「認証ミドルウェアが設定されているときだけcontextを見る」だったが、それだとfork先が `Handler()` の外側で認証する構成 ( 本体から見ると `authMW` はnil ) で、contextにUserが載っていても無視されてしまう。認証している人が居るのにOSユーザー名で記録される、という同じ事故が別ルートで復活する。「Userが居るなら使う。居ないときだけ `authMW` を見て異常かどうか決める」に直してある
- チェックがJSONデコード直後にあるのも意図がある。この後にはパス解決 ( ファイルシステムへのアクセス ) やバリデーションが並んでいる。認証構成が壊れているとき、身元不明のリクエストでファイルシステムを触りに行く必要は無い。異常は最も早い時点で止める
- クライアントが `author` を指定する経路は無い。`createCommentRequest` に `Author` フィールドが無いため、リクエストJSONに `"author": "admin"` と書いても捨てられる。認証結果だけがauthorの供給源になる

## 8. auth_test.goに見る「通ること」と「守れていること」の違い

この章のコードは、実装よりテストのほうが長い ( 実装が約80行、テストが453行 ) 。しかもこのテストは一度レビューで差し戻されている。実装は最初から正しかったが、テストが契約を守れていなかった。何が起きたのかを読むと、テストの書き方について学べることが多い。

### 落とし穴1: ステータスコードだけを見ていた

7節の「認証ありでUserが無ければ500」を検証するテストは、当初こうだった。

```go
if rec.Code != http.StatusInternalServerError {
    t.Errorf("expected 500, got %d", rec.Code)
}
```

これは通る。だが守れていない。実装を次のように書き換えてもテストは緑のままだった。

```go
} else if s.authMW != nil {
    s.store.Create(store.Comment{Path: ..., Anchor: ..., Body: ...})  // 保存してから
    s.internalError(w, r, errors.New("authenticated request has no user"))  // 500を返す
    return
}
```

500は返っているのでテストは満足する。しかしコメントはOSユーザー名で保存されており、この節が防ごうとした事故がそのまま起きている。守りたかったのは「500が返ること」ではなく「記録が汚染されないこと」だった。

修正後はストアの状態まで見る。

```go
comments, err := store.NewFileStore(rootDir).List("spec.md")
if err != nil {
    t.Fatalf("failed to list persisted comments: %v", err)
}
if len(comments) != 0 {
    t.Errorf("persisted comments = %+v, want none", comments)
}
```

### 落とし穴2: 何にでも通るテスト

「認証ミドルウェアが全10ルートを守っている」ことを、当初は10個のパスを列挙して401を確認していた。だがテスト用のミドルウェアは `next` を呼ばずに即401を返す。

```go
func alwaysUnauthorized(http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
	})
}
```

つまりリクエストがmuxに到達しないので、パスが実在するかどうかに関係なく401になる。`/totally/bogus/path` と書いても通るし、11個目のルートを足しても落ちない。証明できていたのは「認証がすべてのパスを止める」という1事実だけで、「10個のルートが守られている」ではなかった。

修正では、ルート定義を `serverRoutes` として実装と共有し、そこから数える。

```go
// Handlerが実際に登録する共有ルート表を数えるため、ルートの増減もこのテストを失敗させる。
if got, want := len(serverRoutes), 10; got != want {
    t.Fatalf("registered route count = %d, want %d", got, want)
}
for _, route := range serverRoutes {
    method, target := authTestRequestForRoute(t, route.pattern)
    // ...401を確認...
}
```

これでルートを1本足せばテストが落ちる。将来ルートを追加した人に「認証の観点で確認したか」を問う柵になる。

### 落とし穴3: 順序に柵が無かった

6節の積層順は、当初Hostチェックについてしか検証されていなかった。認証をOriginチェックより外側に移す変更を入れても、テストは全部通ってしまう。実際の挙動は正しいのに、将来それが壊れても誰も気づけない状態だった。

修正後はガード3種それぞれについて、403になることと、認証ミドルウェアが1度も呼ばれていないことの両方を見る。

```go
if authCalls != 0 {
    t.Errorf("auth middleware called %d times for requests rejected by guards, want 0", authCalls)
}
```

読みどころ。

- 3件に共通するのは「テストが通ること」と「守りたい性質が守られていること」がずれていた点。前者は書きやすく、後者は意図的に狙わないと書けない
- 有効性を確かめる手段が変異テスト ( mutation testing ) の発想。実装をわざと壊してみて、テストが落ちるかを見る。落ちなければ、そのテストはその性質を守っていない。今回の3件はすべてこの方法で発見され、修正後も同じ方法で有効性が確認されている
- 落とし穴2は特に示唆的で、`len(tests) == 10` という「一見ちゃんとしたアサーション」が入っていた。だが数えていたのはテスト自身の表であって実装ではないので、何も守っていなかった。テストが自分自身のコピーを検証していないか、常に疑う価値がある

## 9. この章の時点でまだ動いていないもの

レビューするときに混乱しないよう、現在地をはっきりさせておく。

この章のコードは `cmd/mdmiel/main.go` から一度も呼ばれていない。`--listen` フラグも環境変数の読み取りも入っておらず、`WithAuth` を渡す人がどこにも居ない。つまり現時点で `./mdmiel <dir>` を起動しても、認証は影も形も無いままこれまで通り動く。

これは意図的な順序になっている。認証の作業は5本に分割されていて、公開経路を実際に開くのは最後の1本だけ。途中でマージが止まっても、無防備に公開された状態が生まれないようにするためだ。

| 順 | 内容 | 状態 |
|---|---|---|
| A | `internal/auth` 骨格 | この章 ( 完了 ) |
| B | `WithAuth` 適用 + author接続 | この章 ( 完了 ) |
| C | 公開構成ガード ( 外部Origin・Content-Type検査・`/raw/` のCSP ) | 未着手 |
| D | Basic認証リファレンス実装 | 未着手 |
| E | `main.go` 配線 + ドキュメント | 未着手 |

したがってこの章を読んでレビューするときの観点は「認証が正しく動くか」ではなく、「差し込み口としての契約が過不足なく決まっているか」「認証を差し込んだfork先が事故を起こさない形になっているか」になる。

現時点で分かっている制約も挙げておく。いずれも後続の作業でドキュメント化される。

- 認証ミドルウェアは、`Handler()` に通す全リクエストで `WithUser` を呼ぶ必要がある。「GETは匿名で通し、POSTだけ認証する」という構成は、7節の3番目の分岐に当たって500になる
- `author` に入るのは `DisplayName()` = 表示名なので、同姓同名を区別できない。`User.ID` はどこにも保存されない
- 認証を通した `/api/events` ( SSE ) は、この時点ではまだ実地検証されていない

## この章のまとめ

- 本体は認証方式を持たず、差し込み口だけを提供する。方式はfork先の責務
- `Middleware` は `func(http.Handler) http.Handler` の型エイリアス。レスポンスを書ける形にしておかないとOIDCで詰む
- 認証済みIDは非公開キーでcontextに載せる。偽装経路が構造的に塞がれる
- 積層順は「攻撃者に副作用を起こさせない」( ガードが先 ) と「fork先が自前のパスを生やせる」( muxより外 ) の2要件で決まる
- 認証ありでUserが無ければ500。静かにOSユーザー名で記録するくらいなら落ちる
- テストは「通ること」ではなく「守りたい性質が守られていること」を狙う。確かめる手段は実装をわざと壊してみること

次の章はまだ無い。後続の作業で公開構成ガード ( C ) 、Basic認証 ( D ) 、`main.go` 配線 ( E ) が入ったところで、この章に続きが足される。
