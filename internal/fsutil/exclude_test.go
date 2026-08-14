package fsutil

import "testing"

// TestIsExcludedFile は、一覧に出すファイル名の規則を固定する。
// ResolveSecurePath が "." 始まりセグメントを403にするため、ここで同じものを
// 除外していないと「一覧に出るのに開けない」エントリが生まれる。
func TestIsExcludedFile(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{".hidden.md", true}, {".env", true}, {".DS_Store", true},
		{"doc.md", false}, {"README.md", false}, {"index.html", false},
		// 途中のドットは隠しファイルではない ( 除外しすぎると通常の文書が消える )
		{"release.notes.md", false}, {"v1.2.md", false},
		// node_modules はディレクトリ規則の担当であり、同名ファイルは除外しない
		{"node_modules", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsExcludedFile(tt.name); got != tt.want {
				t.Errorf("IsExcludedFile(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestIsExcludedDir(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{".mdmiel", true}, {".git", true}, {".env", true}, {"node_modules", true},
		{"docs", false}, {"sub", false}, {"assets", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsExcludedDir(tt.name); got != tt.want {
				t.Errorf("IsExcludedDir(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}
