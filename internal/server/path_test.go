package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveSecurePath(t *testing.T) {
	tmpDir := t.TempDir()
	rootDir := filepath.Join(tmpDir, "root")
	err := os.Mkdir(rootDir, 0755)
	if err != nil {
		t.Fatalf("failed to create root dir: %v", err)
	}

	// テスト用の通常ファイル作成
	safeFile := filepath.Join(rootDir, "safe.txt")
	if err := os.WriteFile(safeFile, []byte("safe"), 0644); err != nil {
		t.Fatalf("failed to create safe file: %v", err)
	}

	// サブディレクトリ作成
	subDir := filepath.Join(rootDir, "sub")
	if err := os.Mkdir(subDir, 0755); err != nil {
		t.Fatalf("failed to create sub dir: %v", err)
	}
	subSafeFile := filepath.Join(subDir, "subsafe.txt")
	if err := os.WriteFile(subSafeFile, []byte("subsafe"), 0644); err != nil {
		t.Fatalf("failed to create subsafe file: %v", err)
	}

	// 境界外のファイル
	unsafeFile := filepath.Join(tmpDir, "unsafe.txt")
	if err := os.WriteFile(unsafeFile, []byte("unsafe"), 0644); err != nil {
		t.Fatalf("failed to create unsafe file: %v", err)
	}

	// 境界内を指すシンボリックリンク
	safeLink := filepath.Join(rootDir, "safe_link")
	if err := os.Symlink(safeFile, safeLink); err != nil {
		t.Fatalf("failed to create safe link: %v", err)
	}

	// 境界外を指すシンボリックリンク
	unsafeLink := filepath.Join(rootDir, "unsafe_link")
	if err := os.Symlink(unsafeFile, unsafeLink); err != nil {
		t.Fatalf("failed to create unsafe link: %v", err)
	}

	// リンク切れのシンボリックリンク ( 境界内 / 境界外を指すもの )
	danglingLink := filepath.Join(rootDir, "dangling_link")
	if err := os.Symlink(filepath.Join(rootDir, "missing.txt"), danglingLink); err != nil {
		t.Fatalf("failed to create dangling link: %v", err)
	}
	danglingUnsafeLink := filepath.Join(rootDir, "dangling_unsafe_link")
	if err := os.Symlink(filepath.Join(tmpDir, "missing.txt"), danglingUnsafeLink); err != nil {
		t.Fatalf("failed to create dangling unsafe link: %v", err)
	}

	// t.TempDir はプラットフォームによってはシンボリックリンク配下 ( macOSの/var→/private/var等 )
	// を返すため、解決済みパスの期待値はEvalSymlinks後のrootDirを基準にする
	evalRootDir, err := filepath.EvalSymlinks(rootDir)
	if err != nil {
		t.Fatalf("failed to eval root dir: %v", err)
	}

	tests := []struct {
		name     string
		relPath  string
		wantErr  error
		wantPath string // wantErrがnilのときのみ検証する ( rootDir基準の相対パス )
	}{
		{
			name:    "safe file inside root",
			relPath: "safe.txt",
			wantErr: nil,
		},
		{
			name:    "safe file inside subfolder",
			relPath: "sub/subsafe.txt",
			wantErr: nil,
		},
		{
			name:    "safe symlink inside root",
			relPath: "safe_link",
			wantErr: nil,
		},
		{
			name:    "absolute path rejected",
			relPath: unsafeFile, // 絶対パス
			wantErr: ErrForbidden,
		},
		{
			name:    "relative traversal rejected",
			relPath: "../unsafe.txt",
			wantErr: ErrForbidden,
		},
		{
			name:    "nested relative traversal rejected",
			relPath: "sub/../../unsafe.txt",
			wantErr: ErrForbidden,
		},
		{
			name:    "symlink pointing outside rejected",
			relPath: "unsafe_link",
			wantErr: ErrForbidden,
		},
		{
			// 書き込み系のパス解決を成立させるため、境界が安全なら未作成のパスも解決して返す
			name:     "nonexistent file inside root resolves",
			relPath:  "nonexistent.txt",
			wantErr:  nil,
			wantPath: "nonexistent.txt",
		},
		{
			name:     "nonexistent file inside subfolder resolves",
			relPath:  "sub/nonexistent.txt",
			wantErr:  nil,
			wantPath: filepath.Join("sub", "nonexistent.txt"),
		},
		{
			name:    "nonexistent file under nonexistent dir returns NotExist",
			relPath: "nosuchdir/nonexistent.txt",
			wantErr: os.ErrNotExist,
		},
		{
			name:    "nonexistent file outside root rejected",
			relPath: "../nonexistent.txt",
			wantErr: ErrForbidden,
		},
		{
			// リンク切れは追跡先を検証できないため、境界外を指し得るものとして拒否する
			name:    "dangling symlink rejected",
			relPath: "dangling_link",
			wantErr: ErrForbidden,
		},
		{
			name:    "dangling symlink pointing outside rejected",
			relPath: "dangling_unsafe_link",
			wantErr: ErrForbidden,
		},
		{
			name:    "empty path rejected",
			relPath: "",
			wantErr: ErrForbidden,
		},
		{
			name:    "backslash traversal rejected",
			relPath: `sub\..\..\unsafe.txt`,
			wantErr: ErrForbidden,
		},
		{
			name:    "backslash in filename rejected",
			relPath: `safe\file.txt`,
			wantErr: ErrForbidden,
		},
		{
			name:    "dot segment directory rejected",
			relPath: ".mdmiel/comments/x.json",
			wantErr: ErrForbidden,
		},
		{
			name:    "dot segment file rejected",
			relPath: ".env",
			wantErr: ErrForbidden,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ResolveSecurePath(rootDir, tt.relPath)
			if tt.wantErr != nil {
				if err == nil {
					t.Errorf("expected error, got nil")
				} else if tt.wantErr == ErrForbidden && err != ErrForbidden {
					t.Errorf("expected ErrForbidden, got %v", err)
				} else if tt.wantErr == os.ErrNotExist && !os.IsNotExist(err) {
					t.Errorf("expected NotExist error, got %v", err)
				}
				if got != "" {
					t.Errorf("expected empty path on error, got %s", got)
				}
			} else {
				if err != nil {
					t.Errorf("unexpected error: %v", err)
				}
				if tt.wantPath != "" {
					want := filepath.Join(evalRootDir, tt.wantPath)
					if got != want {
						t.Errorf("expected resolved path %s, got %s", want, got)
					}
				}
			}
		})
	}
}
