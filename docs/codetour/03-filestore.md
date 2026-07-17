# 03. サイドカーJSONへの永続化 — internal/store/filestore.go ( 226行 )

02章で定義したStore interfaceの唯一の実装、FileStoreを読む。コメント1件を1つのJSONファイルとして書き出す仕組みと、その書き込みを安全にするアトミック書き込みがこの章の肝。

この章のゴール。

- ポインタレシーバ ( `func (fs *FileStore) ...` ) の意味と、値レシーバとの違いを説明できる
- 一時ファイル+os.Renameによるアトミック書き込みが何を防いでいるか説明できる
- 依存ゼロでUUIDを自作している理由と、その実装がやっていることを説明できる

## 1. FileStore structとメソッドレシーバ

```go
// FileStore はコメントを <rootDir>/.mdmiel/comments/<id>.json に1コメント=1ファイルで
// 保存するStore実装。Gitでのチーム共有時にマージコンフリクトを避けるための構成 ( docs/requirements.md F9 )。
type FileStore struct {
	rootDir string
}

// NewFileStore は rootDir 配下の .mdmiel/comments/ を保存先とするFileStoreを作る。
// ディレクトリは初回書き込み時に遅延作成されるため、ここでは作成しない。
func NewFileStore(rootDir string) *FileStore {
	return &FileStore{rootDir: rootDir}
}

func (fs *FileStore) commentsDir() string {
	return filepath.Join(fs.rootDir, ".mdmiel", "comments")
}

func (fs *FileStore) commentPath(id string) string {
	return filepath.Join(fs.commentsDir(), id+".json")
}
```

読みどころ。

- `func (fs *FileStore) commentsDir() string` の `(fs *FileStore)` の部分をレシーバと呼ぶ。Goにはクラスが無く、代わりに「この型に対する関数」としてメソッドを定義する構文がこれ。`fs` は他言語での `this` / `self` に相当する変数名で、呼び出し側からは `myFileStore.commentsDir()` のように呼べる
- レシーバが `*FileStore` ( ポインタ ) になっている点に注目。値レシーバ `(fs FileStore)` だとメソッド呼び出しのたびにstructがコピーされ、メソッド内での変更が呼び出し元に反映されない。ここではFileStore自体を書き換えるメソッドは無いが、structのコピーコストを避ける・型全体でレシーバの種類を統一する ( 一部だけ値レシーバにすると挙動の予測が難しくなる ) という理由でポインタレシーバに揃えている。`NewFileStore` が `*FileStore` ( ポインタ ) を返しているのもこれと対応する
- 1コメント=1ファイルという構成の理由は、docコメントに明記されている通りGitでのマージコンフリクト回避だが、それだけではない。Git共有そのものは設計上の選択肢として残されている ( docs/requirements.md F9と受け入れ基準に明記 )。`.mdmiel/` をgitignoreするかどうかは利用側プロジェクトごとの判断で、mdmielリポジトリ自身はドッグフーディング用のコメントをローカル限定にするためignoreしている
- Gitで共有せずローカルだけで使う場合でも、1件=1ファイルには利点がある。別コメントは別ファイルなので同時書き込みの衝突が構造的に起きない、4節で見る `writeAtomic` が1ファイル単位で完結する、AIエージェントがidだけで個別コメントを読み書きしやすい、の3点
- チーム運用が本格化した場合は、02章で見たStore interfaceごとサーバー/DB実装に差し替える想定になっている。Git共有はサーバーを立てずに済む中間形態という位置づけで、それでも足りなくなればinterfaceの差し替えでDBストアへ移行できる
- `NewFileStore` はディレクトリを作らない、というコメントにも注目。コンストラクタで即座に副作用 ( ディレクトリ作成などのI/O ) を起こさない設計で、実際のディレクトリ作成は5節の `writeAtomic` 内の `os.MkdirAll` まで遅延される。一度もコメントが付かないファイルセットに対して `.mdmiel/` が生成されないのは、この遅延生成の直接の帰結
- `commentsDir` / `commentPath` は小文字始まりなので非公開のヘルパーメソッド。パッケージ外からは呼べず、FileStore内部でのパス組み立てだけに使われる

## 2. List: 走査とソート

```go
// List はcommentsDir配下の全ファイルを走査し、pathが一致するコメントのみを
// createdAt昇順で返す。ディレクトリが未作成 ( コメントが1件も無い ) 場合は空スライスを返す。
func (fs *FileStore) List(path string) ([]Comment, error) {
	dir := fs.commentsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Comment{}, nil
		}
		return nil, err
	}

	comments := make([]Comment, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			// tmpファイル ( .json.tmp-<rand> ) やディレクトリは無視する
			continue
		}

		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}

		var c Comment
		if err := json.Unmarshal(data, &c); err != nil {
			continue
		}

		if c.Path == path {
			comments = append(comments, c)
		}
	}

	// createdAtは秒精度の文字列で同値になり得る。sort.Sliceは非安定のため、
	// 同値時はidを二次キーにして決定的な昇順を保証する。
	sort.Slice(comments, func(i, j int) bool {
		if comments[i].CreatedAt != comments[j].CreatedAt {
			return comments[i].CreatedAt < comments[j].CreatedAt
		}
		return comments[i].ID < comments[j].ID
	})

	return comments, nil
}
```

読みどころ。

- `os.ReadDir(dir)` はディレクトリ内のエントリ一覧を返す標準関数。ディレクトリがまだ存在しない場合はエラーになるが、`os.IsNotExist(err)` で「存在しないだけ」のエラーを判別し、その場合は空スライス `[]Comment{}` を正常系として返している。1節の「ディレクトリは遅延作成」がここでも効いていて、コメントが1件も無いファイルを開いても `List` はエラーにならず空配列を返す
- ループ内の `filepath.Ext(e.Name()) != ".json"` で拡張子フィルタをかけている。コメントにある通り、4節のアトミック書き込みが一時的に作る `.json.tmp-<rand>` ファイルを取り違えないための防御
- `os.ReadFile` が失敗した場合や `json.Unmarshal` が失敗した場合は、いずれも `continue` で読み飛ばすだけでエラーを返さない。壊れたJSONファイルが1つ混ざっていても `List` 全体は失敗させず、読める分だけ返す設計になっている
- `comments := make([]Comment, 0, len(entries))` は長さ0・容量 `len(entries)` のスライスを作る書き方。最終的な件数は `entries` 以下になることが分かっているので、`append` のたびに再確保が起きないよう容量だけ先に確保している
- ソートは `sort.Slice` に比較関数を渡す形。`createdAt` はRFC3339の秒精度文字列なので、同じ秒に複数コメントが作られると値が同じになりうる。`sort.Slice` は安定ソートを保証しないため、同値のときに毎回同じ順序になる保証が無い。それを避けるため `createdAt` が同じ場合は `id` を二次キーにして常に同じ順序になるようにしている

## 3. Create/Get/Update/Delete

```go
// Create はサーバー生成フィールド ( id・version・createdAt・resolved ) を付与して
// アトミックに保存する。authorが空の場合はOSユーザー名で補完する ( MVPの暫定仕様 )。
func (fs *FileStore) Create(c Comment) (Comment, error) {
	id, err := newID()
	if err != nil {
		return Comment{}, err
	}

	c.ID = id
	c.Version = 1
	c.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	c.UpdatedAt = ""
	c.Resolved = false
	if c.Author == "" {
		c.Author = currentOSUser()
	}

	if err := fs.writeAtomic(c); err != nil {
		return Comment{}, err
	}
	return c, nil
}

// Get はidを指定して単体取得する。存在しなければErrNotFoundを返す。
func (fs *FileStore) Get(id string) (Comment, error) {
	data, err := os.ReadFile(fs.commentPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return Comment{}, ErrNotFound
		}
		return Comment{}, err
	}

	var c Comment
	if err := json.Unmarshal(data, &c); err != nil {
		return Comment{}, err
	}
	return c, nil
}
```

読みどころ。

- `Create` は呼び出し側から渡された `Comment` のうち `ID` / `Version` / `CreatedAt` / `UpdatedAt` / `Resolved` をサーバー側の値で必ず上書きする。クライアントが `id` や `createdAt` を偽って送ってきても、ここで無条件に上書きされるため反映されない ( サーバーが真実の発行元になる )
- `c.Author == ""` のときだけOSユーザー名 ( `currentOSUser()` ) で補うロジックは、認証機能がまだ無いMVPの暫定仕様であることがコメントに明記されている。将来ログイン機能が入れば、ここはリクエストの認証情報から取るように置き換わるはず
- `Get` は `os.ReadFile` のエラーを `os.IsNotExist` で判定し、ファイルが無いだけのケースをパッケージのsentinel error `ErrNotFound` に変換している。02章で見た「呼び出し側は `errors.Is(err, store.ErrNotFound)` で判定する」という設計がここで実現されている。OS由来の生のエラー ( `*fs.PathError` ) をそのまま外に漏らさず、Storeパッケージの語彙に翻訳している点が要点

```go
// Update は既存コメントを読み込み、updateBody/updateResolved/updateOffsetで指定された
// フィールドのみ上書きしてupdatedAtを付与のうえアトミックに保存する。
func (fs *FileStore) Update(id string, body string, resolved bool, offset *NoteOffset, updateBody bool, updateResolved bool, updateOffset bool) (Comment, error) {
	c, err := fs.Get(id)
	if err != nil {
		return Comment{}, err
	}

	if updateBody {
		c.Body = body
	}
	if updateResolved {
		c.Resolved = resolved
	}
	if updateOffset {
		c.NoteOffset = offset
	}
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if err := fs.writeAtomic(c); err != nil {
		return Comment{}, err
	}
	return c, nil
}

// Delete はidに対応するコメントファイルを削除する。存在しなければErrNotFoundを返す。
func (fs *FileStore) Delete(id string) error {
	if err := os.Remove(fs.commentPath(id)); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	return nil
}
```

読みどころ。

- `Update` はまず `fs.Get(id)` で既存の全フィールドを読み込み、02章のinterfaceで見た3つのboolフラグ ( `updateBody` / `updateResolved` / `updateOffset` ) が立っているものだけを上書きする。フラグが立っていないフィールドは読み込んだ既存値のまま `writeAtomic` に渡るので、意図せず消えることが無い
- `Get` が返すエラー ( `ErrNotFound` を含む ) はそのまま `return Comment{}, err` で素通ししている。`Get` の時点で既にErrNotFoundへの変換が済んでいるので、`Update` 側で改めて変換する必要が無い。エラーの翻訳は発生源に一番近い場所 ( ここでは `Get` ) で1回だけ行う、という設計が徹底されている
- `Delete` は `os.Remove` の失敗を `Get` と同じパターンで `ErrNotFound` に変換している。3つのメソッド ( Get/Update/Delete ) 全てが最終的に同じ変換ロジックを通るため、Storeを呼ぶ側 ( server.go ) は常に `errors.Is(err, store.ErrNotFound)` の1パターンだけを見ればよい

## 4. writeAtomic: アトミック書き込み ( この章の肝 )

```go
// writeAtomic は同ディレクトリの一時ファイル ( <id>.json.tmp-<rand> ) に書き込んでから
// os.Renameで本ファイルへ置き換える。途中クラッシュしても破損した本ファイルを残さない。
func (fs *FileStore) writeAtomic(c Comment) error {
	dir := fs.commentsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	suffix, err := randomHex(8)
	if err != nil {
		return err
	}
	tmpPath := filepath.Join(dir, fmt.Sprintf("%s.json.tmp-%s", c.ID, suffix))

	// Rename成功時以外 ( WriteFile失敗・Rename失敗・途中return ) はtempを掃除する。
	// Rename成功後はtmpPathがもう存在しないためRemoveは空振り ( 無害 ) になる。
	renamed := false
	defer func() {
		if !renamed {
			os.Remove(tmpPath)
		}
	}()

	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}

	if err := os.Rename(tmpPath, fs.commentPath(c.ID)); err != nil {
		return err
	}
	renamed = true
	return nil
}
```

読みどころ。

- もし `os.WriteFile(fs.commentPath(c.ID), data, ...)` のように本ファイルへ直接書き込んでいたら、書き込みの途中 ( ディスクへのフラッシュが半分だけ終わった状態 ) でプロセスが強制終了したりマシンの電源が落ちたりすると、本ファイルが中途半端なバイト列で残ってしまう。次に `List` や `Get` がそのファイルを読むと `json.Unmarshal` が失敗し、コメントが壊れて読めなくなる
- これを避けるため、まず `<id>.json.tmp-<rand>` という別名の一時ファイルにフルの内容を書き切ってから、`os.Rename` で本ファイル名に置き換えている。`os.Rename` はファイルシステムレベルでは「ディレクトリエントリの参照先を切り替えるだけ」の操作であり、内容のコピーを伴わないため、処理が全く行われなかったか完全に行われたかのどちらかにしかならない ( 中間状態が存在しない )。この性質を利用して、本ファイルは常に「直前の完全な内容」か「今回の完全な内容」のどちらかであり続ける
- 一時ファイルを本ファイルと同じディレクトリ ( `dir := fs.commentsDir()` ) に作っているのが重要なポイント。`os.Rename` の原子性 ( atomicity ) は同一ファイルシステム内でのみ保証される。もし一時ファイルをOSの `/tmp` のような別ディレクトリ ( 別ファイルシステムにマウントされている可能性がある ) に作ってから本ファイルの場所へRenameしようとすると、OSによっては内部的に「コピーしてから元を消す」という非原子的な処理にフォールバックしてしまい、この関数が防ぎたいクラッシュ耐性が失われる
- `suffix, err := randomHex(8)` でファイル名にランダムなサフィックスを付けているのは、同じコメントIDに対して同時に複数の書き込みが走った場合 ( 通常運用では稀だが ) に一時ファイル名が衝突しないようにするため
- `defer func() { if !renamed { os.Remove(tmpPath) } }()` は「関数を抜けるときに必ず実行される」deferの典型的な使い方。`WriteFile` 失敗時もRename失敗時も、この defer がフラグ `renamed` を見て一時ファイルの掃除をする。Rename成功後は `tmpPath` が既にリネームされて存在しないため、`os.Remove` は「対象が無い」エラーを返すだけで実害は無い ( エラーを無視しているのはそのため )

## 5. newID: 依存ゼロでUUIDv4

```go
// newID はcrypto/randで16バイト生成し、UUIDv4形式 ( 8-4-4-4-12、hex ) の文字列にする。
// 外部uuidライブラリは使わない。
func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// RFC4122に沿ってバージョン(4)とバリアントビットを設定する
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// randomHex はn バイトのランダム値をhex文字列にする ( 一時ファイル名のサフィックス用 )。
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}
```

読みどころ。

- importの `"crypto/rand"` に注目 ( ファイル冒頭のimport一覧を参照 )。Goには乱数生成が `crypto/rand` と `math/rand` の2系統ある。`math/rand` は再現可能な疑似乱数 ( シード値が同じなら同じ列を返す ) で、統計処理やゲームには向くがID生成には向かない。`crypto/rand` はOSが提供する暗号学的に安全な乱数源 ( `/dev/urandom` 相当 ) を使い、予測不可能性が求められるID・トークン生成にはこちらを使うのが鉄則
- `newID` は16バイト ( 128ビット ) のランダム値を取り、RFC4122のUUIDv4仕様に沿ってバージョンビット ( `b[6]` の上位4ビットを `0100` に固定 ) とバリアントビット ( `b[8]` の上位2ビットを `10` に固定 ) を設定してから、`8-4-4-4-12` の16進数表記に整形している。これは市販のUUIDライブラリが内部でやっていることと同じ処理を、標準ライブラリだけで自前実装したもの
- なぜ外部の `uuid` パッケージ ( 例えば `google/uuid` ) を使わずに自作しているか。00章・01章で確認した「バックエンドは標準ライブラリのみで書かれている」という依存ゼロ方針がここでも一貫している。UUIDv4の生成は数行で書ける処理であり、1つの外部依存を追加するコスト ( go.sum管理・脆弱性追跡・ビルド時のダウンロード ) に見合わないという判断
- `randomHex` は `newID` とほぼ同じ形をしているが、UUIDのような特定フォーマットへの整形は行わず、単純な16進文字列を返すだけの汎用ヘルパー。4節の一時ファイル名サフィックスに使われている

疑問はこのファイルの該当行に付箋で。次は04章、パストラバーサル対策へ。
