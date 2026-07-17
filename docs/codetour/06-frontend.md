# 06. フロントエンド概観 — web/src/

このツアーはGo学習が主目的のため、フロントエンドは薄めに概観するだけに留める。データがどう流れ、どこで「行番号」がDOMに埋め込まれ、どこでコメントの行ズレを吸収しているかという、Go側とつながる部分だけを押さえる。

この章のゴール。

- `main.tsx` → `App.tsx` → `SplitView` → `StickyNoteLayer` / `CommentSidebar` というデータフローの大枠を説明できる
- `data-source-line` 属性がどこで注入され、00章のアーキテクチャ図のどこに対応するか説明できる
- 行ズレ追従 ( F10 ) のロジックが `lib/comments.ts` にあり、`lib/anchor.ts` とは役割が別だと説明できる

## 1. データフローの全体像

```tsx
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

読みどころ。

- `main.tsx` はReactアプリのマウントだけを行うエントリポイント。01章のGoの `func main()` に相当する存在で、ここから先は全て `<App />` 以下のコンポーネントツリーに委ねられる
- `App.tsx` が状態管理の起点。`viewState` ( URLハッシュから復元した表示状態 )、`commentsPanelOpen` ( コメントパネルの開閉 )、`commentsByPane` ( 左右ペインごとのコメント一覧 ) を持ち、`GET /api/files` 相当のファイル選択とコメント取得をここで統括する
- `SplitView` が実際の描画を担当する。`viewState` から左右ペインのパスを取り出し、`GET /api/file?path=...` でファイル内容を取得し、markdownかhtmlかに応じて `renderer/markdown.ts` / `renderer/html.ts` でレンダリングしたHTMLを表示する。各ペインの `pane-content` 要素の上に `StickyNoteLayer` が付箋オーバーレイとして重なる
- `StickyNoteLayer` は行に対応する付箋カードを絶対配置で表示するオーバーレイ、`CommentSidebar` はコメント一覧を表示する補助パネルで既定は閉じている ( `commentsPanelOpen` の初期値が `false` )。両者は同じ `commentsByPane` を参照するので、`App` がコメントを1箇所でだけ取得すれば両方に反映される

## 2. renderer/markdown.ts: 行アンカーの仕込み

```ts
export function sourceLinePlugin(md: MarkdownIt) {
  md.core.ruler.push('source_line', (state) => {
    // Only top-level (block) tokens are annotated; inline children tokens
    // don't render their own attrs, so recursing into them has no effect.
    for (const token of state.tokens) {
      if (token.map) {
        const line = token.map[0] + 1; // 1-based line number
        token.attrSet('data-source-line', String(line));
      }
    }
    return true;
  });
}

const md = new MarkdownIt({
  html: false, // Ensure raw HTML is escaped for security as per specs
  linkify: true,
});

md.use(sourceLinePlugin);
```

読みどころ。

- `markdown-it` はcoreルールにフックを差し込める設計になっており、`md.core.ruler.push('source_line', ...)` で独自のポスト処理ルールを追加している。各ブロックトークンが持つ `token.map` ( ソース上の開始・終了行 ) を読み、`data-source-line` というカスタム属性としてHTMLに焼き込む
- ここが00章のアーキテクチャ図でいう「行単位の付箋コメント」の土台。行3の右クリックメニューも、`StickyNoteLayer` の付箋位置決めも、全てレンダリング後のDOMから `[data-source-line="N"]` を探すことで実現しており、その属性を仕込んでいるのがこのプラグイン
- `html: false` はコンストラクタオプションで、生のHTMLタグをエスケープする指定。要件定義書のF2 ( 生HTMLはエスケープ ) に対応する設定で、Markdown内に埋め込まれた `<script>` 等がそのまま実行されないようにしている

## 3. renderer/html.ts: data-source-lineの注入とiframe配信

```ts
  const baseHref = `/raw/${parentDir}`;

  // Parse HTML with location info enabled.
  const document = parse(html, { sourceCodeLocationInfo: true });

  // Helper to recursively traverse and modify nodes.
  const traverse = (node: any) => {
    if (node.tagName) {
      // 1. Inject data-source-line attribute if location info is available.
      if (node.sourceCodeLocation) {
        const startLine = node.sourceCodeLocation.startLine;
        if (!node.attrs) {
          node.attrs = [];
        }
        const hasSourceLine = node.attrs.some((attr: any) => attr.name === 'data-source-line');
        if (!hasSourceLine) {
          node.attrs.push({ name: 'data-source-line', value: String(startLine) });
        }
      }
```

読みどころ。

- HTMLモックの場合はmarkdown-itの代わりに `parse5` ( HTML5仕様準拠のパーサー ) を使う。`sourceCodeLocationInfo: true` を指定してパースすると、各要素ノードが `sourceCodeLocation.startLine` を持つようになり、それを `data-source-line` 属性として書き戻している。markdown-itとは実装が別でも、狙いは全く同じ ( 行番号をDOM属性に焼き込む )
- `<base href="/raw/${parentDir}">` を `<head>` に注入している ( 全文は割愛 )。これはHTMLモック内の相対パスCSS/画像 ( `<img src="./logo.png">` 等 ) を、05章で見た `GET /raw/` エンドポイント経由で解決させるための仕掛け。要件定義書のF3 ( 相対パスのCSS/画像も解決 ) がこれで実現されている
- レンダリング結果は `SplitView` で `sandbox="allow-same-origin"` を指定した `<iframe srcDoc={...}>` に流し込まれる。サンドボックス化することでHTMLモック内のスクリプトが親ページ ( mdmiel本体 ) のDOMやCookieに直接触れないようにしつつ、`allow-same-origin` で `/raw/` への相対リクエストだけは許可している

## 4. lib/: 行ズレ追従・API呼び出し・付箋レイアウト

```ts
export function computeSnippet(lineText: string): string {
  return lineText.trim().replace(/\s+/g, ' ');
}

// ...

export function rematchLine(params: RematchLineParams): RematchLineResult {
  const { content, anchorLine, snippetHash: targetHash, radius = 200 } = params;
  const lines = content.split('\n');
  const total = lines.length;

  const lo = Math.max(1, anchorLine - radius);
  const hi = Math.min(total, anchorLine + radius);

  let bestLine: number | null = null;
  let bestDistance = Infinity;

  for (let ln = lo; ln <= hi; ln++) {
    const text = lines[ln - 1];
    const hash = snippetHash(computeSnippet(text));
    if (hash === targetHash) {
      const distance = Math.abs(ln - anchorLine);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLine = ln;
      }
    }
  }

  if (bestLine === null) {
    return { line: anchorLine, orphaned: true };
  }
  return { line: bestLine, orphaned: false };
}
```

読みどころ。

- 行ズレ追従 ( 要件定義書F10 ) の実体は `lib/comments.ts` の `rematchLine`。ファイル名だけ見ると紛らわしいが、URLハッシュ ( `#/view?path=...&line=...` ) の読み書きを担う `lib/anchor.ts` ( `parseHash` / `generateHash` ) とは別ファイルで、役割が異なる。`comments.ts` 冒頭のコメントにも「anchor.tsとその既存テストを触らずに済むよう分離した」とある通り、意図的に分けられている
- `rematchLine` は02章の `Anchor` structで見た `line` / `snippet` / `snippetHash` を使い、保存時の `anchorLine` を中心に前後 ( 既定200行 ) の範囲を走査、各行を `computeSnippet` ( 空白正規化 ) してハッシュ化し、保存時のハッシュと一致する行のうち最も近いものを採用する。見つからなければ `orphaned: true` を返し、`StickyNoteLayer` の未解決ゾーンに回される。行番号だけでなくテキストのハッシュも保存しておく02章の設計判断が、ここでフル活用されている
- `lib/commentsApi.ts` は `GET/POST/PATCH/DELETE /api/comments` それぞれに対応する薄い `fetch` ラッパ ( `listComments` / `createComment` / `patchComment` / `deleteComment` )。05章で見たサーバー側のレスポンス形をそのままTypeScriptの型として受け取るだけで、業務ロジックは持たない
- `lib/stickyLayout.ts` は付箋カード同士が重ならないよう縦方向にずらす `stackNotes` ( 貪欲法で上から順に押し下げる ) や、ユーザーがドラッグで動かした付箋 ( `noteOffset` が付いている ) をスタッキング対象から除外する `partitionStackable` など、DOM操作を伴わない純粋関数だけを集めている。実際のDOM測定は `StickyNoteLayer` コンポーネント側が担当し、ここはテスト可能なロジックだけを切り出す構成になっている

## 5. ビルドの輪

`cd web && npm run build` で `web/dist/` が生成され、それが05章で見た `//go:embed all:dist` でGoバイナリに焼き込まれる。フロントエンドのソースは実行時には一切参照されず、`mdmiel` バイナリ1個だけがビルド成果物として残る。00章の「配布物はGoバイナリ1個」という設計上のポイントは、この06章まで読んだことで一周してつながったことになる。

これでツアーは完結。
