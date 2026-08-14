package fsutil

import "testing"

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
