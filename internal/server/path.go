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
