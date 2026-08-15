//go:build !unix

package server

import "testing"

// addPlatformFixtures のUnix以外向けの実装。シンボリックリンクは特権が要り、
// バックスラッシュ入りの名前もFIFOも作れないため、追加の実体は用意しない。
func addPlatformFixtures(t *testing.T, root, outsideDir string) (mustList, mustNotList []string) {
	t.Helper()
	return nil, nil
}
