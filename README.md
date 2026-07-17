# mdmiel

Markdown / HTMLをローカルサーバーで閲覧し、行単位の付箋コメントを貼れるGo製レビューツール。

AI成果物のレビュー基地として設計している。生成した要件定義Markdownと、それを元にしたモックHTMLを並べて閲覧し、人が行単位でコメントを残す。コメントはサイドカーJSON ( .mdmiel/comments/*.json ) に永続化されるため、機械的に読み込んで修正ループを回せる。実装後はコードから生成した解説ドキュメントを同じ流れでレビューでき、コードを全量読まずに実装を検証する入口になる ( 実践例: docs/codetour/ )。

## 特徴

- Markdown / HTMLをローカルHTTPサーバーで配信・閲覧
- 左右2ペインのsplit表示で要件mdとモックhtmlを見比べられる
- 行単位の付箋コメント ( ドラッグで位置調整可能。ファイル更新で行がずれても追従 )
- 任意の行を指す共有用リンクURLを発行できる
- コメントはrootDir配下の .mdmiel/comments/<id>.json に永続化
- Go製・単一バイナリ ( バックエンドはGo標準ライブラリのみ )
- フロントエンドはReact + Vite ( ビルド成果物をバイナリにembed )
- ローカル専用: 127.0.0.1のみにバインドし、LANには公開しない

## ビルド

先にフロントエンドをビルドする ( 成果物 web/dist がGoバイナリにembedされる )。web/dist と web/node_modules はリポジトリに含めないため、clone後は必ずこの手順が必要。

```
cd web && npm install && npm run build && cd ..
go build -o mdmiel ./cmd/mdmiel
```

## 使い方

```
./mdmiel <dir> [--port 8686]
```

指定したディレクトリ配下のMarkdown / HTMLをブラウザで閲覧できる ( 起動時にブラウザが自動で開く。--port省略時は8686 )。

## ドキュメント

- [docs/requirements.md](docs/requirements.md) — 要件定義書。何を・なぜ作るかの正本
- [docs/design/](docs/design/) — 要件定義書を元にした画面モックHTML
- [docs/codetour/](docs/codetour/) — コード解説ツアー。学習順 ( 00〜 ) にmdmiel自身で閲覧できる

要件md×モックhtmlをmdmiel自身で並べてレビューする、ドッグフーディング構成になっている。

## 開発

- バックエンド: Go ( cmd/mdmiel, internal/ )
- フロントエンド: web/ ( React + Vite )。ビルドは `cd web && npm run build`、成果物は web/dist にembedされる
- テスト: `go test ./...`

## ライセンス

MIT License.
