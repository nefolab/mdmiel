# 04. パストラバーサル対策 — internal/server/path.go ( 92行 )

`/api/file?path=../../../etc/passwd` のようなリクエストを拒否する、パストラバーサル対策の中核関数 `ResolveSecurePath` を読む。ローカル専用ツールだからといって無防備にしてよい理由にはならない。ブラウザは悪意あるWebページが開いていても `127.0.0.1` 宛にリクエストを飛ばせてしまうため、サーバー側でも境界チェックが要る ( Originヘッダを検証する05章の対策と合わせた多層防御の一角 )。

この章のゴール。

- `ResolveSecurePath` が行う複数段階のチェックを、上から順に説明できる
- `filepath.Join` / `filepath.Rel` / `filepath.EvalSymlinks` がそれぞれ何を検証しているか説明できる
- ガード節 ( 早期return ) スタイルと、02章で見たsentinel errorパターンの再登場を確認する

## 1. sentinel errorとガード節による早期拒否

```go
package server

import (
	"errors"
	"path/filepath"
	"strings"
)

var (
	ErrInvalidPath = errors.New("invalid path")
	ErrForbidden   = errors.New("forbidden")
)

// ResolveSecurePath はユーザーから指定された相対パスを rootDir に対し安全に解決します。
// パストラバーサル脆弱性を防ぐため、以下のチェックを行います。
// 1. 絶対パス指定の拒否
// 2. filepath.Join 後の filepath.Rel を用いた境界チェック
// 3. シンボリックリンク解決 ( filepath.EvalSymlinks ) 後の境界チェック
func ResolveSecurePath(rootDir, relPath string) (string, error) {
	// 空パスの拒否 ( ルートディレクトリ自体を返さない )
	if relPath == "" {
		return "", ErrForbidden
	}

	// バックスラッシュを含むパスの拒否
	// ( Windowsでは区切り文字としてトラバーサルに使われ得るため、位置を問わず安全側で一律拒否 )
	if strings.Contains(relPath, "\\") {
		return "", ErrForbidden
	}

	// 絶対パスの拒否
	if filepath.IsAbs(relPath) {
		return "", ErrForbidden
	}

	// スラッシュで始まるパスも拒否
	if strings.HasPrefix(relPath, "/") {
		return "", ErrForbidden
	}

	// 「.」で始まるパスセグメント ( "." 単独・".." を含む ) の拒否
	// ( .mdmiel・.git・.env 等の隠しファイル/ディレクトリへの直接アクセスを防ぐ )
	for _, seg := range strings.Split(relPath, "/") {
		if strings.HasPrefix(seg, ".") {
			return "", ErrForbidden
		}
	}
```

読みどころ。

- `var ( ErrInvalidPath = ...; ErrForbidden = ... )` は02章で見たsentinel errorパターンの再登場。ただし実際に見ていくと、この関数が返すのは一貫して `ErrForbidden` で、`ErrInvalidPath` はこのファイル内では使われていない。サーバー層 ( 05章 ) が将来別の入力検証エラーに使うことを見込んで確保されている変数、という読み方になる
- 5つのチェックが全て「条件に合致したら即 `return "", ErrForbidden`」というガード節 ( 早期return ) スタイルで並んでいる。ネストしたif/elseにせず、駄目なケースを上から順に弾いていくことで、最後まで残った入力だけが「まだ疑わしいが形式的には妥当」という状態になる
- 空パス拒否は「rootDir自体を指す `path=""` のようなリクエストでルートディレクトリを丸ごと返さない」ためのガード
- バックスラッシュの一律拒否は、この関数がWindows上でも同じロジックで動く前提のため。Windowsでは `\` がパス区切りとして働き `..\..\etc` のようなトラバーサルに使えてしまうので、実行OSを問わず一律で拒否している ( 09行目のバックスラッシュ判定はOS分岐が無い点に注目 )
- ドット始まりセグメントの拒否が、`.mdmiel` ( コメントの保存先 )、`.git`、`.env` のような隠しファイルへの直接アクセスを防いでいる。`strings.Split(relPath, "/")` でセグメントに分解し、各セグメントの先頭文字だけを見ているので、`sub/.git/config` のような深い位置のドットディレクトリも漏れなく拾える

## 2. filepath.Join + Rel による境界チェック

```go
	// ルートディレクトリの絶対パス化
	absRootDir, err := filepath.Abs(rootDir)
	if err != nil {
		return "", err
	}

	// パスを結合してクリーンアップ
	joined := filepath.Join(absRootDir, relPath)

	// filepath.Rel による境界チェック
	rel, err := filepath.Rel(absRootDir, joined)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", ErrForbidden
	}
```

読みどころ。

- `filepath.Join(absRootDir, relPath)` は単純な文字列連結ではなく、結合結果を正規化 ( クリーンアップ ) する。たとえば `relPath` が `sub/../../etc` のような相対パスでも、`Join` はまず `..` を字面上で解決してしまう。1節のガード節をすり抜けた入力があっても、ここで最終的な絶対パスが確定する
- `filepath.Rel(absRootDir, joined)` は「`joined` は `absRootDir` から見てどんな相対パスか」を計算する。もし `joined` が `absRootDir` の外にあれば、結果は `".."` から始まる文字列になる ( 例: `../../etc/passwd` )。この性質を利用して `strings.HasPrefix(rel, "..")` で境界外を検出している
- ここまでで一見安全に見えるが、まだ不十分。次節のシンボリックリンク解決が必要な理由は、`joined` が「文字列としては rootDir 配下」でも、そのパスの実体がシンボリックリンクで外部を指している可能性が残っているため

## 3. EvalSymlinksによるシンボリックリンク解決後の再チェック

```go
	// ルートディレクトリのシンボリックリンク解決
	evalRootDir, err := filepath.EvalSymlinks(absRootDir)
	if err != nil {
		return "", err
	}

	// 対象パスのシンボリックリンク解決
	evalJoined, err := filepath.EvalSymlinks(joined)
	if err != nil {
		// ファイルまたはディレクトリが存在しない場合、親ディレクトリの境界チェックを行う
		parent := filepath.Dir(joined)
		evalParent, errParent := filepath.EvalSymlinks(parent)
		if errParent == nil {
			relParent, errRel := filepath.Rel(evalRootDir, evalParent)
			if errRel != nil || strings.HasPrefix(relParent, "..") {
				return "", ErrForbidden
			}
		}
		return "", err
	}

	// 解決後のパスが evalRootDir の配下にあるか検証
	relEval, err := filepath.Rel(evalRootDir, evalJoined)
	if err != nil || strings.HasPrefix(relEval, "..") {
		return "", ErrForbidden
	}

	return evalJoined, nil
}
```

読みどころ。

- `filepath.EvalSymlinks` はパス上のシンボリックリンクを全て解決し、実体の絶対パスを返す。rootDir配下に「外部を指すシンボリックリンク」が置かれていた場合、2節の文字列ベースの境界チェックだけでは検出できない ( リンクの名前自体はrootDir配下だから )。解決後のパスで改めて `filepath.Rel` + `HasPrefix(rel, "..")` の境界チェックをやり直しているのがこの節の核心
- `evalJoined, err := filepath.EvalSymlinks(joined)` がエラーを返すケースの多くは「対象がまだ存在しない」 ( 新規作成前のパスなど )。この場合 `EvalSymlinks` は解決しようがないので失敗する。ここで単純に `ErrForbidden` を返すと、rootDir配下の存在しないファイルへの正当なアクセス ( 例えば `GET /api/file?path=new.md` が404を返すべきケース ) まで一律403になってしまう
- そこでエラー時は親ディレクトリ ( `filepath.Dir(joined)` ) だけを `EvalSymlinks` し、親が境界内かどうかを確認する。親が境界外なら `ErrForbidden` を返すが、親が境界内 ( = 対象は単に存在しないだけ ) であれば、最後の `return "", err` で元の生の `err` ( 典型的には `*fs.PathError` で `os.IsNotExist` 判定できるもの ) をそのまま返している。つまり「境界外への存在しないパスへのアクセス」は `ErrForbidden` に、「境界内の存在しないパスへのアクセス」は生の not-exist エラーに、意図的に出し分けている。呼び出し元 ( 05章のhandleFile等 ) はこれを見て403と404を使い分けられる
- path_test.goの `"nonexistent file inside root"` と `"nonexistent file outside root rejected"` の2ケースは、まさにこの出し分けを検証している ( 次節 )

## 4. path_test.goに見るテーブル駆動テスト

```go
	tests := []struct {
		name    string
		relPath string
		wantErr error
	}{
		{
			name:    "safe file inside root",
			relPath: "safe.txt",
			wantErr: nil,
		},
		// ...
		{
			name:    "nonexistent file inside root ( returns OsNotExist but not ErrForbidden )",
			relPath: "nonexistent.txt",
			wantErr: os.ErrNotExist,
		},
		{
			name:    "nonexistent file outside root rejected",
			relPath: "../nonexistent.txt",
			wantErr: ErrForbidden,
		},
		// ...
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := ResolveSecurePath(rootDir, tt.relPath)
			// ...
		})
	}
```

読みどころ。

- テーブル駆動テスト ( table-driven test ) はGoの定番イディオム。「入力と期待値の組」を無名structのスライスとして列挙し、1つの `for` ループで全ケースを回す。ケースを増やすのに新しい関数を書く必要が無く、`tests` スライスに要素を1つ足すだけで済む
- `t.Run(tt.name, func(t *testing.T) { ... })` はサブテストを作る呼び出し。`go test -run TestResolveSecurePath/nonexistent_file_inside_root` のようにケース単位で実行でき、失敗時の出力にも `tt.name` がそのまま出るのでどのケースで落ちたか一目で分かる
- path_test.goには3節で見た「境界内の存在しないパス」「境界外の存在しないパス」「境界外を指すシンボリックリンク」「バックスラッシュを含むトラバーサル」など、この章で読んだ分岐の数だけケースが用意されている。関数のロジックとテストケースを1対1で読み比べると理解の確認になる

疑問はこのファイルの該当行に付箋で。次は05章、HTTPサーバーとAPIへ。
