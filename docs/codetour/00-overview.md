# 00. 全体像 — mdmielコードツアー

mdmielのソースコードを学習順に読み解くツアーの第0章。まず全体の地図を頭に入れて、以降の章で各ファイルを深掘りする。

- 対象: 2026-07-14時点のワーキングツリー ( 初期インポート前のスナップショット )
- 読み方: このドキュメント自体をmdmielで開き、疑問がある行に付箋コメントを貼る。Claudeが `.mdmiel/comments/` を読んで回答・改訂する ( ドッグフーディング )
- 注意: mdmielは `.md` / `.html` しか表示できないため、各章に `.go` のコード抜粋を埋め込んである。原本をエディタで並べて読むとより効果的

## mdmielとは

何を・なぜ作るかは docs/requirements.md ( 要件定義書 ) が正本。このツアーは「どう作られているか」だけを扱う。一言でいえば、Markdown/HTMLをローカルサーバーで閲覧し行単位の付箋コメントを貼れるGo製レビューツール。

## アーキテクチャ

登場人物は3つ。GoのHTTPサーバー、その中に埋め込まれたReact SPA、そしてファイルシステム。

```
┌─────────────────────┐        ┌──────────────────────────────┐
│ ブラウザ            │  HTTP  │ mdmiel ( Goバイナリ1個 )     │
│                     │◄──────►│                              │
│ React SPA           │        │  net/http サーバー           │
│ ( Goバイナリに      │        │   ├ GET  /            SPA配信│
│   go:embedで同梱 )  │        │   ├ GET  /api/files   一覧   │
│                     │        │   ├ GET  /api/file    本文   │
│ ・md/htmlレンダリング│        │   ├ GET  /raw/        html用 │
│ ・付箋コメントUI    │        │   └ CRUD /api/comments       │
└─────────────────────┘        └──────────┬───────────────────┘
                                          │ 読み書き
                               ┌──────────▼───────────────────┐
                               │ ファイルシステム ( rootDir ) │
                               │  ├ 配下の.md/.html全て 閲覧対象│
                               │  └ .mdmiel/comments/<id>.json│
                               │     ( コメント1件=1ファイル )│
                               └──────────────────────────────┘
```

設計上のポイント。

- 配布物はGoバイナリ1個。ReactのビルドHTML/JSは `go:embed` でバイナリに焼き込まれる ( 05章 )
- コメントはDBではなくサイドカーJSON。1コメント=1ファイルにすることで書き込み衝突を構造的に避け、Git共有の選択肢も残す ( 詳細は03章 )
- サーバーは `127.0.0.1` バインド + Origin/Host検証で、ローカル外からのアクセスとDNSリバインディングを防ぐ ( 05章 )

## リクエストの流れ ( 起動から付箋まで )

1. `mdmiel <dir> --port 8686` で起動。`main.go` が引数を解釈しサーバーを組み立てる
2. ブラウザが `/` を開くと、embedされたReact SPAが返る
3. SPAが `GET /api/files` でmd/html一覧を取得し、サイドバーに表示
4. ファイルを選ぶと `GET /api/file?path=...` で本文を取得し、フロント側でレンダリング
5. 行を選んでコメントを書くと `POST /api/comments` → サーバーが `.mdmiel/comments/<uuid>.json` に保存
6. 以降の閲覧では `GET /api/comments?path=...` で取得し、付箋として該当行に重ねる

## ディレクトリ構成とGoプロジェクトレイアウト

```
mdmiel/
├── go.mod                  モジュール定義 ( モジュール名: mdmiel )
├── cmd/
│   └── mdmiel/
│       └── main.go         エントリポイント ( 01章 )
├── internal/
│   ├── store/
│   │   ├── store.go        コメントの型とStore interface ( 02章 )
│   │   └── filestore.go    サイドカーJSON実装 ( 03章 )
│   └── server/
│       ├── path.go         パストラバーサル対策 ( 04章 )
│       └── server.go       HTTPルーティングとAPI ( 05章 )
├── web/
│   ├── embed.go            distをバイナリに埋め込む3行 ( 05章 )
│   └── src/                React SPA ( 06章で概観 )
└── docs/
    ├── requirements.md     要件定義書 ( 何を・なぜ )
    ├── design/             画面モック ( claude design作 )
    └── codetour/           このツアー
```

Goの慣習として押さえること。

- cmd/<アプリ名>/main.go: 実行バイナリの入口を置く定番レイアウト。ライブラリコードと分離する
- internal/: Go言語仕様で保護されるディレクトリ。`internal/` 配下のパッケージは、このモジュールの外からimportできない ( コンパイルエラーになる )。「外部に公開しない実装詳細」を機械的に強制できる
- パッケージ名 = ディレクトリ名が慣習。`internal/store` のファイルは全て `package store`
- テストは `_test.go` サフィックスで実装と同じディレクトリに置く。`go test ./...` で全パッケージ実行

## go.mod

```go
module mdmiel

go 1.26.4
```

- module行がimportパスの起点。`import "mdmiel/internal/store"` のように使う
- 依存が1行も無い点に注目。バックエンドはGo標準ライブラリのみで書かれている ( UUIDも自作、ルーティングもnet/http )。依存を増やさない判断は03章・05章で効いてくる

## 章立てと読み順

| 章 | ファイル | テーマ |
|---|---|---|
| 00 | ( このファイル ) | 全体地図 |
| 01 | cmd/mdmiel/main.go | エントリポイント・flag・goroutine |
| 02 | internal/store/store.go | interface設計・struct・JSONタグ |
| 03 | internal/store/filestore.go | 実装・アトミック書き込み・UUID自作 |
| 04 | internal/server/path.go | パストラバーサル対策 |
| 05 | internal/server/server.go | ルーティング・ミドルウェア・embed |
| 06 | web/src/ | フロントエンド概観 ( 薄め ) |

## 動かしてから読む

コードリーディングは「動くものを触ってから」が鉄則。まずビルドして起動する。

```
cd web && npm install && npm run build && cd ..
go build -o mdmiel ./cmd/mdmiel
./mdmiel . --port 8686
```

フロントのビルドが先なのは、成果物 web/dist がGoバイナリに `go:embed` で焼き込まれるため ( 05章 )。distが無い状態で `go build` するとコンパイルエラーになる。ビルド済みのdistが手元に残っていれば1行目はスキップできる。

ブラウザが自動で開き、このツアーのmdが一覧に見えたら成功。

疑問・ツッコミはこのファイルの該当行に付箋で。次は01章、main.goへ。
