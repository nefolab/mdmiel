# 02. コメントの型とStore interface — internal/store/store.go ( 63行 )

付箋コメントの中核データ型と、それを永続化するための抽象 ( interface ) を読む。実装 ( FileStore ) はまだ出てこない。「何を保存するか」「保存操作をどう抽象化するか」の設計だけに集中する回。

この章のゴール。

- Comment structの各フィールドとJSONタグの対応を説明できる
- なぜ `NoteOffset` がポインタ型 ( `*NoteOffset` ) なのか、値型との違いを理由付きで説明できる
- Goのinterfaceが「メソッドの集合」であり、実装側に `implements` 宣言が要らないことを理解する

## 1. パッケージコメントとsentinel error

```go
// Package store は行コメントの永続化を抽象化する。
// MVP では FileStore ( サイドカーJSON: <rootDir>/.mdmiel/comments/<id>.json ) が唯一の実装だが、
// 将来のチーム対応でサーバー/DBストアに差し替えられるよう interface を切っている。
package store

import "errors"

// ErrNotFound は指定されたidのコメントが存在しない場合に返される。
var ErrNotFound = errors.New("comment not found")
```

読みどころ。

- `package store` の直前に置かれたdocコメントは、そのパッケージ全体の説明として `go doc` コマンドやエディタのホバー表示に使われる。Goの慣習として「パッケージの説明は package句の直前のコメントに書く」というルールがある ( 途中に空行を挟むと切れる )
- `var ErrNotFound = errors.New(...)` はsentinel error ( 見張り役のエラー ) と呼ばれるパターン。特定のエラー状態をパッケージレベルの変数として1つだけ用意し、呼び出し側は文字列比較ではなく `errors.Is(err, store.ErrNotFound)` で判定する。文字列でエラーメッセージを比較するとメッセージ変更に弱いが、sentinel errorなら変数の同一性で判定できるので壊れにくい
- この変数は03章のFileStoreで実際に返される ( `Get` / `Update` / `Delete` が対象コメント不在時に返す )

## 2. structとJSONタグ ( Anchor / NoteOffset / Comment )

```go
// Anchor はコメントが紐づくソース行の位置情報。
// 行番号だけでなく前後テキストのハッシュも持たせ、ファイル更新で行がずれても
// snippet 再マッチで表示位置を補正できるようにする ( docs/requirements.md F10 )。
type Anchor struct {
	Line        int    `json:"line"`
	Snippet     string `json:"snippet"`
	SnippetHash string `json:"snippetHash"`
}

// NoteOffset はコメントの付箋UI表示位置を、アンカー基準からのドラッグ差分 ( dx, dy ) として
// 保持する。dx/dyの単位はフロントエンド側の座標系に委ねる ( サーバー側は不透明な数値として扱う )。
type NoteOffset struct {
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
}

// Comment は1件の行コメント。JSONタグはサイドカーファイルのフィールド名と一致させる ( camelCase )。
type Comment struct {
	Version    int         `json:"version"`
	ID         string      `json:"id"`
	Path       string      `json:"path"`
	Anchor     Anchor      `json:"anchor"`
	Body       string      `json:"body"`
	Author     string      `json:"author"`
	CreatedAt  string      `json:"createdAt"`
	UpdatedAt  string      `json:"updatedAt,omitempty"`
	Links      []string    `json:"links,omitempty"`
	NoteOffset *NoteOffset `json:"noteOffset,omitempty"`
	Resolved   bool        `json:"resolved"`
}
```

読みどころ。

- Goには `public` / `private` キーワードが無く、識別子の先頭文字の大小がそのまま公開範囲になる。`Line` や `Comment` のように大文字始まりのフィールド・型はパッケージ外から見える ( エクスポートされる )。小文字始まりなら同一パッケージ内でしか見えない。フィールド名がそのままアクセス制御になっている
- 各フィールドの後ろに付いた `` `json:"..."` `` はstruct tagと呼ばれるメタ情報の一種。`encoding/json` パッケージがMarshal/Unmarshal時にこのタグを読み、Goのフィールド名 ( `CreatedAt` ) とJSONのキー名 ( `createdAt` ) を対応付ける。タグが無ければフィールド名がそのままJSONキーになるが、Goの慣習 ( PascalCase ) とJSONの慣習 ( camelCase ) が食い違うため明示している
- `omitempty` はそのフィールドがゼロ値 ( 空文字列・0・nil・空スライス等 ) のとき、JSON出力そのものから省くオプション。`UpdatedAt` は未更新のコメントでは空文字列になるため、`"updatedAt": ""` を出さずにキーごと消える
- `NoteOffset *NoteOffset` だけポインタ型になっているのは、「付箋位置を一度もドラッグしていない ( 未設定 )」と「ドラッグして (0, 0) に置いた ( 値がある )」を区別するため。値型 `NoteOffset` のままだとゼロ値が `{0, 0}` になってしまい、この2つの状態を見分けられない。ポインタなら未設定を `nil` で表現でき、`omitempty` と組み合わせると未設定時はJSONにキーごと現れない。実際に `.mdmiel/comments/*.json` を覗くと、`noteOffset` キーが無いコメントと `{"dx":..., "dy":...}` を持つコメントの両方が存在し、それがこの区別に対応している
- Anchorの `Snippet` / `SnippetHash` はdocコメントの通り、ファイルが編集されて行番号がずれたときに前後テキストを手がかりに該当行を再マッチさせるための情報。`Line` だけでは編集に弱いのでこの2つを添えている

## 3. Store interface

```go
// Store は行コメントの永続化操作を抽象化する。
type Store interface {
	// List は指定されたpathに紐づくコメントをcreatedAt昇順で返す。
	List(path string) ([]Comment, error)

	// Create は id・version・createdAt・resolved をサーバー側で付与して保存し、
	// 保存後のComment ( サーバー生成フィールド込み ) を返す。
	Create(c Comment) (Comment, error)

	// Get はidを指定して単体取得する。存在しなければErrNotFoundを返す。
	Get(id string) (Comment, error)

	// Update は部分更新を行う。updateBody/updateResolved/updateOffsetで各フィールドを
	// 更新するかどうかを区別し、更新対象のみ反映してupdatedAtを付与する。
	// updateOffsetがtrueのときoffset ( nil可、付箋位置のドラッグオフセット ) をそのまま
	// NoteOffsetへ反映し、falseのときは既存のNoteOffsetを変更しない。
	// 存在しなければErrNotFoundを返す。
	Update(id string, body string, resolved bool, offset *NoteOffset, updateBody bool, updateResolved bool, updateOffset bool) (Comment, error)

	// Delete はidを指定して削除する。存在しなければErrNotFoundを返す。
	Delete(id string) error
}
```

読みどころ。

- Goのinterfaceは「このメソッド群を持つ型なら何でもOK」という約束事の集合でしかない。Java/C#のように `class FileStore implements Store` と明示的に宣言する必要は無く、`List` / `Create` / `Get` / `Update` / `Delete` の5メソッドを同じシグネチャで持ってさえいれば、その型は自動的に `Store` として扱える。これを構造的型付け ( structural typing ) と呼ぶ
- なぜここでinterfaceを切るか。理由は2つ。1つはパッケージdocコメントに明記されている通り、MVPではFileStoreのみだが将来サーバー/DBストアに差し替えられるようにするため。もう1つはテストでの差し替え ( 本物のファイルI/Oをせず、メモリ上の偽Storeで高速にテストする ) ができるようにするため。01章で見た `server.NewServer(absDir, web.Dist, fileStore)` の第3引数がまさに `Store` 型で受け取られており、mainが具象型 ( `*FileStore` ) を選んでいるだけで、Server側はinterfaceしか知らない
- `Update` のシグネチャが `updateBody bool, updateResolved bool, updateOffset bool` という3つの真偽値フラグを引きずっているのが目を引く。これはHTTPのPATCH ( 部分更新 ) を素直に表現するための設計。「bodyを更新する/しない」と「bodyを空文字列に更新する」は別物であり、この区別をStore層まで運ぶ必要がある。もし `Update(id string, body string, resolved bool, offset *NoteOffset) error` のようにフラグを省くと、「bodyを更新しない」のか「bodyを空文字列にしたい」のか呼び出し側の意図をStoreが判別できなくなる。この設計は05章で見るリクエスト構造体 ( `*string` / `*bool` のようなポインタフィールドで「キーが無い=nil」を表現するアプローチ ) と対になっている。呼び出し側 ( server.go ) ではポインタのnil/非nilで意図を表現し、Store層に渡すときにboolフラグへ変換している

疑問はこのファイルの該当行に付箋で。次は03章、FileStore実装へ。
