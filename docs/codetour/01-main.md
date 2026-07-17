# 01. エントリポイント — cmd/mdmiel/main.go ( 115行 )

プログラムの入口。CLIの引数解釈、サーバーの組み立て、起動までの一本道を読む。

この章のゴール。

- Goプログラムがどこから始まるか ( package main / func main ) を説明できる
- `if err != nil` というGoのエラー処理イディオムに慣れる
- goroutine ( `go func()` ) が何をしているか説明できる

## 1. エントリポイントの決まりごと

```go
package main

import (
	"flag"
	"fmt"
	"mdmiel/internal/server"
	"mdmiel/internal/store"
	"mdmiel/web"
	"log"
	"net/http"
	"os"
	// ...
)

func main() {
	// サブコマンドは持たない ( 閲覧サーバーの起動が唯一の動作 )。機能追加はweb UI側で行う方針
	fs := flag.NewFlagSet("mdmiel", flag.ExitOnError)
	port := fs.String("port", "8686", "Port to bind HTTP server")
```

読みどころ。

- `package main` + `func main()` の組だけが実行バイナリになる。他のパッケージ ( `package store` 等 ) はライブラリで、mainから呼ばれるだけ
- importの `"mdmiel/internal/server"` は、go.modの `module mdmiel` を起点にしたパス。相対import ( `../` ) はGoには無い
- サブコマンドをあえて持たない設計。人がレビュー・閲覧するためのツールで機能追加はweb UI側に足す方針のため、`mdmiel <dir>` だけで起動する。cobra等のCLIフレームワークも使わない ( 依存ゼロ方針 )
- `flag.NewFlagSet` はフラグ集合を作る。`fs.String` の戻り値は値そのものではなくポインタ ( `*string` )。後で `*port` と参照剥がしして使う

## 2. flagパッケージと引数の事前振り分け

```go
	// flag は最初の非フラグ引数でパースを止めるため、
	// "mdmiel <dir> --port N" と "mdmiel --port N <dir>" の両形式に対応できるよう
	// フラグと位置引数を事前に振り分けてから 1 回だけパースする
	var flagArgs, posArgs []string
	rest := os.Args[1:]
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		if strings.HasPrefix(arg, "-") {
			flagArgs = append(flagArgs, arg)
			// "--port 8686" のように値が別引数で続く形式を拾う
			if !strings.Contains(arg, "=") && i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "-") {
				i++
				flagArgs = append(flagArgs, rest[i])
			}
		} else {
			posArgs = append(posArgs, arg)
		}
	}

	if err := fs.Parse(flagArgs); err != nil {
		log.Fatalf("failed to parse flags: %v", err)
	}
```

読みどころ。

- `os.Args` はコマンドライン引数のスライス。`os.Args[0]` はバイナリ名なので、実引数は `os.Args[1:]`
- Go標準のflagは「最初の非フラグ引数が出たらパース終了」という仕様。`mdmiel <dir> --port N` と書くと `--port` が無視されてしまう。ここでは事前にフラグと位置引数を自前で振り分けることで、引数順を自由にしている
- `var flagArgs, posArgs []string` はnilスライスの宣言。Goでは nilスライスにも `append` できる ( 初期化不要 ) のがイディオム
- `if err := fs.Parse(...); err != nil` の形は「if文の中で代入と判定を同時にやる」Go頻出パターン。errのスコープがifの中に閉じる

## 3. エラー処理の文化: if err != nil

```go
	targetDir := posArgs[0]
	absDir, err := filepath.Abs(targetDir)
	if err != nil {
		log.Fatalf("failed to get absolute path of directory: %v", err)
	}

	// ディレクトリ存在チェック
	info, err := os.Stat(absDir)
	if err != nil {
		log.Fatalf("failed to read directory: %v", err)
	}
	if !info.IsDir() {
		log.Fatalf("path is not a directory: %s", absDir)
	}
```

読みどころ。

- Goには例外 ( try/catch ) が無い。失敗しうる関数は `(結果, error)` の2値を返し、呼び出し側が毎回 `if err != nil` で判定する。冗長に見えるが「エラーを無視した箇所が見た目で分かる」のが利点
- `:=` は宣言+代入、`=` は代入のみ。2つ目の `info, err := ...` は infoが新規・errが既存だが、左辺に1つでも新規変数があれば `:=` が使える ( 再宣言ルール )
- `log.Fatalf` は stderr にログを出して `os.Exit(1)` する。mainの浅い層でだけ使ってよい関数で、ライブラリ側 ( internal/ ) では使わずerrorを返す。この使い分けは02章以降で確認する

## 4. 組み立て: 依存性注入

```go
	// サーバーインスタンス生成 ( コメントはrootDir配下の.mdmiel/comments/にFileStoreで永続化 )
	fileStore := store.NewFileStore(absDir)
	srv, err := server.NewServer(absDir, web.Dist, fileStore)
	if err != nil {
		log.Fatalf("failed to create server: %v", err)
	}

	handler := srv.Handler()

	addr := fmt.Sprintf("127.0.0.1:%s", *port)
	url := fmt.Sprintf("http://%s/", addr)
```

読みどころ。

- ここがこのファイルの核心。mainの仕事は「部品を作って注入して起動する」だけで、ロジックを持たない
- `server.NewServer(absDir, web.Dist, fileStore)` の第3引数は `store.Store` というinterface型で受けている ( 02章 )。mainが具象型 ( FileStore ) を選んで渡すので、将来DBストアに差し替えるときもこの1行を変えるだけで済む
- `web.Dist` はReactビルド成果物を焼き込んだ `embed.FS` ( 05章 )
- `127.0.0.1` 固定バインドに注目。`0.0.0.0` にしないことで、LAN内の他マシンからアクセスできないローカル専用ツールになる

## 5. goroutineでブラウザ自動起動

```go
	log.Printf("Starting mdmiel server on %s", url)
	log.Printf("Serving files from: %s", absDir)

	// ブラウザ自動起動処理
	go func() {
		// サーバーの起動待ちのために少しスリープ
		time.Sleep(100 * time.Millisecond)
		openBrowser(url)
	}()

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("server stopped with error: %v", err)
	}
}
```

読みどころ。

- `go func() { ... }()` は無名関数をgoroutine ( 軽量スレッド ) として並行実行する構文。ここでは「100ms待ってからブラウザを開く」処理を裏で走らせている
- なぜ裏で走らせるか: 次の行の `http.ListenAndServe` はサーバーが止まるまで返ってこないブロッキング呼び出しだから。先にブラウザを開こうとするとサーバーがまだ居らず、後に書くと永遠に実行されない
- `time.Sleep(100 * time.Millisecond)` は雑な同期に見えるが、「ListenAndServeがポートを開くまでの猶予」として実用上十分という割り切り。厳密にやるなら `net.Listen` を先に済ませてから `http.Serve` に渡す手もある

## 6. クロスプラットフォーム対応

```go
func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default: // linux 等
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		log.Printf("failed to open browser: %v", err)
	}
}
```

読みどころ。

- `runtime.GOOS` はビルド対象OSを表す定数 ( "darwin" = macOS )。Goのswitchはbreak不要で、fallthroughしないのがデフォルト
- `cmd.Start()` は起動だけして終了を待たない ( `cmd.Run()` は待つ )。ブラウザの終了を待つ必要は無いのでStart
- ここだけ `log.Fatalf` ではなく `log.Printf`。ブラウザが開けなくてもサーバー本体は動き続けるべき、という失敗の重み付けがされている

疑問はこのファイルの該当行に付箋で。次は02章、Store interfaceの設計へ。
