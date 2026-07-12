# mdmiel

Markdown / HTMLをローカルサーバーで閲覧し、行単位の付箋コメントを貼れるGo製レビューツール。

AI成果物のレビュー基地として設計している。生成した要件定義Markdownと、それを元にしたモックHTMLを並べて閲覧し、人が行単位でコメントを残す。コメントはサイドカーJSON ( .mdmiel/comments/*.json ) に永続化されるため、機械的に読み込んで修正ループを回せる。

## 特徴

- Markdown / HTMLをローカルHTTPサーバーで配信・閲覧
- 行単位の付箋コメント
- コメントはrootDir配下の .mdmiel/comments/<id>.json に永続化
- Go製・単一バイナリ・サードパーティ依存なし
- フロントエンドはReact + Vite ( ビルド成果物をバイナリにembed )

## ビルド

先にフロントエンドをビルドする ( 成果物 web/dist がGoバイナリにembedされる )。web/dist と web/node_modules はリポジトリに含めないため、clone後は必ずこの手順が必要。

```
cd web && npm install && npm run build && cd ..
go build -o mdmiel ./cmd/mdmiel
```

## 使い方

```
./mdmiel serve <dir> --port 8686
```

指定したディレクトリ配下のMarkdown / HTMLをブラウザで閲覧できる。

## 開発

- バックエンド: Go ( cmd/mdmiel, internal/ )
- フロントエンド: web/ ( React + Vite )。ビルドは `cd web && npm run build`、成果物は web/dist にembedされる
- テスト: `go test ./...`

## ライセンス

MIT License.
