package server

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
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
//
// 未作成のパスも、親ディレクトリが境界内なら解決して返します。
//
// 制約: 本関数はパス文字列を検査して返すだけなので、解決から利用までの間に
// 対象を境界外シンボリックリンクへ差し替えられるTOCTOUを防げません。書き込み先の
// 決定にそのまま使わないでください ( 解決と利用を一体化する os.Root 系への移行が本筋 )。
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

	// ルートディレクトリのシンボリックリンク解決
	evalRootDir, err := filepath.EvalSymlinks(absRootDir)
	if err != nil {
		return "", err
	}

	// 対象パスのシンボリックリンク解決
	evalJoined, err := filepath.EvalSymlinks(joined)
	if err != nil {
		// 通常ファイルをディレクトリとして辿ったパス ( existing.txt/foo ) は
		// 存在しないリソースとして扱い、呼び出し側が404にマップできるようにする
		if errors.Is(err, syscall.ENOTDIR) {
			return "", os.ErrNotExist
		}
		// 実体があるのに解決できないケース ( リンク切れ・循環したシンボリックリンク ) は
		// 追跡先を検証できない。境界外を指している可能性があるため拒否する。
		// EvalSymlinksは循環時にELOOPではなく素のerrorを返すため、エラー種別の分類ではなく
		// Lstatによる実体の有無で判定する
		if _, errLstat := os.Lstat(joined); errLstat == nil {
			return "", ErrForbidden
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		// パスの末尾が存在しない場合は、親ディレクトリまでを解決して境界チェックを行い、
		// 解決済みの親 + 末尾セグメントを返す ( 書き込み系のパス解決を成立させるため )。
		// 親自体が存在しない場合は解決不能なので、そのまま NotExist を返す。
		parent := filepath.Dir(joined)
		evalParent, errParent := filepath.EvalSymlinks(parent)
		if errParent != nil {
			return "", err
		}
		relParent, errRel := filepath.Rel(evalRootDir, evalParent)
		if errRel != nil || strings.HasPrefix(relParent, "..") {
			return "", ErrForbidden
		}
		return filepath.Join(evalParent, filepath.Base(joined)), nil
	}

	// 解決後のパスが evalRootDir の配下にあるか検証
	relEval, err := filepath.Rel(evalRootDir, evalJoined)
	if err != nil || strings.HasPrefix(relEval, "..") {
		return "", ErrForbidden
	}

	return evalJoined, nil
}
