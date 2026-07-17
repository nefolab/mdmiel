package store

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFileStoreRoundTrip(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	c := Comment{
		Path: "spec.md",
		Anchor: Anchor{
			Line:        10,
			Snippet:     "hello world",
			SnippetHash: "abc123",
		},
		Body: "first comment",
	}

	created, err := fs.Create(c)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if created.ID == "" {
		t.Fatal("expected generated ID")
	}
	if created.Version != 1 {
		t.Errorf("expected version 1, got %d", created.Version)
	}
	if created.CreatedAt == "" {
		t.Error("expected createdAt to be set")
	}
	if created.Resolved {
		t.Error("expected resolved=false on create")
	}

	got, err := fs.Get(created.ID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.Body != "first comment" {
		t.Errorf("unexpected body: %s", got.Body)
	}
	if got.Anchor.Line != 10 || got.Anchor.SnippetHash != "abc123" {
		t.Errorf("unexpected anchor: %+v", got.Anchor)
	}

	list, err := fs.List("spec.md")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(list) != 1 || list[0].ID != created.ID {
		t.Errorf("unexpected list result: %+v", list)
	}

	updated, err := fs.Update(created.ID, "updated body", true, nil, true, true, false)
	if err != nil {
		t.Fatalf("Update failed: %v", err)
	}
	if updated.Body != "updated body" || !updated.Resolved {
		t.Errorf("update not applied: %+v", updated)
	}
	if updated.UpdatedAt == "" {
		t.Error("expected updatedAt to be set")
	}

	if err := fs.Delete(created.ID); err != nil {
		t.Fatalf("Delete failed: %v", err)
	}

	if _, err := fs.Get(created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound after delete, got %v", err)
	}

	listAfterDelete, err := fs.List("spec.md")
	if err != nil {
		t.Fatalf("List after delete failed: %v", err)
	}
	if len(listAfterDelete) != 0 {
		t.Errorf("expected no comments after delete, got %+v", listAfterDelete)
	}
}

func TestFileStoreUpdatePartial(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	created, err := fs.Create(Comment{Path: "spec.md", Body: "original", Resolved: false})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// body のみ更新: resolved は変化しない
	bodyOnly, err := fs.Update(created.ID, "new body", true /* 無視される値 */, nil, true, false, false)
	if err != nil {
		t.Fatalf("Update (body only) failed: %v", err)
	}
	if bodyOnly.Body != "new body" {
		t.Errorf("expected body updated, got %s", bodyOnly.Body)
	}
	if bodyOnly.Resolved {
		t.Errorf("expected resolved unchanged (false), got true")
	}

	// resolved のみ更新: body は変化しない
	resolvedOnly, err := fs.Update(created.ID, "ignored", true, nil, false, true, false)
	if err != nil {
		t.Fatalf("Update (resolved only) failed: %v", err)
	}
	if resolvedOnly.Body != "new body" {
		t.Errorf("expected body unchanged, got %s", resolvedOnly.Body)
	}
	if !resolvedOnly.Resolved {
		t.Errorf("expected resolved updated to true")
	}
}

// TestFileStoreUpdateNoteOffsetRoundTrip はnoteOffsetを更新すると永続化・再取得後も
// dx/dyが保持されることを確認する。
func TestFileStoreUpdateNoteOffsetRoundTrip(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	created, err := fs.Create(Comment{Path: "spec.md", Body: "original"})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if created.NoteOffset != nil {
		t.Fatalf("expected no noteOffset on create, got %+v", created.NoteOffset)
	}

	offset := &NoteOffset{DX: 12.5, DY: -3.25}
	updated, err := fs.Update(created.ID, "", false, offset, false, false, true)
	if err != nil {
		t.Fatalf("Update (noteOffset) failed: %v", err)
	}
	if updated.NoteOffset == nil || updated.NoteOffset.DX != 12.5 || updated.NoteOffset.DY != -3.25 {
		t.Errorf("expected noteOffset applied, got %+v", updated.NoteOffset)
	}

	got, err := fs.Get(created.ID)
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if got.NoteOffset == nil || got.NoteOffset.DX != 12.5 || got.NoteOffset.DY != -3.25 {
		t.Errorf("expected noteOffset persisted after reload, got %+v", got.NoteOffset)
	}
}

// TestFileStoreUpdateBodyOnlyLeavesNoteOffsetIntact はnoteOffset設定済みのコメントを
// updateOffset=falseでUpdateしても、既存のnoteOffsetが変化しないことを確認する。
func TestFileStoreUpdateBodyOnlyLeavesNoteOffsetIntact(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	created, err := fs.Create(Comment{Path: "spec.md", Body: "original"})
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	offset := &NoteOffset{DX: 5, DY: 7}
	if _, err := fs.Update(created.ID, "", false, offset, false, false, true); err != nil {
		t.Fatalf("Update (noteOffset) failed: %v", err)
	}

	// body のみ更新: noteOffsetはupdateOffset=falseなので変化しないはず
	bodyOnly, err := fs.Update(created.ID, "updated body", false, nil, true, false, false)
	if err != nil {
		t.Fatalf("Update (body only) failed: %v", err)
	}
	if bodyOnly.Body != "updated body" {
		t.Errorf("expected body updated, got %s", bodyOnly.Body)
	}
	if bodyOnly.NoteOffset == nil || bodyOnly.NoteOffset.DX != 5 || bodyOnly.NoteOffset.DY != 7 {
		t.Errorf("expected noteOffset unchanged, got %+v", bodyOnly.NoteOffset)
	}
}

func TestFileStoreListFiltersByPath(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	if _, err := fs.Create(Comment{Path: "a.md", Body: "on a"}); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if _, err := fs.Create(Comment{Path: "b.md", Body: "on b"}); err != nil {
		t.Fatalf("create failed: %v", err)
	}
	if _, err := fs.Create(Comment{Path: "a.md", Body: "on a again"}); err != nil {
		t.Fatalf("create failed: %v", err)
	}

	list, err := fs.List("a.md")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 comments for a.md, got %d", len(list))
	}
	for _, c := range list {
		if c.Path != "a.md" {
			t.Errorf("unexpected path in filtered list: %s", c.Path)
		}
	}

	listB, err := fs.List("b.md")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(listB) != 1 {
		t.Fatalf("expected 1 comment for b.md, got %d", len(listB))
	}

	listNone, err := fs.List("c.md")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(listNone) != 0 {
		t.Fatalf("expected 0 comments for c.md, got %d", len(listNone))
	}
}

func TestFileStoreListWithoutAnyComments(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	// .mdmiel/comments/ が存在しない状態でもエラーにならず空スライスを返す
	list, err := fs.List("spec.md")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(list) != 0 {
		t.Errorf("expected empty list, got %+v", list)
	}
}

func TestFileStoreAtomicWriteLeavesNoTempFile(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	created, err := fs.Create(Comment{Path: "spec.md", Body: "hi"})
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}

	entries, err := os.ReadDir(filepath.Join(rootDir, ".mdmiel", "comments"))
	if err != nil {
		t.Fatalf("failed to read comments dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Errorf("expected exactly 1 file, got %d", len(entries))
	}
	if entries[0].Name() != created.ID+".json" {
		t.Errorf("unexpected filename: %s", entries[0].Name())
	}

	// Update後もtmpファイルが残らないこと
	if _, err := fs.Update(created.ID, "updated", false, nil, true, false, false); err != nil {
		t.Fatalf("update failed: %v", err)
	}
	entries, err = os.ReadDir(filepath.Join(rootDir, ".mdmiel", "comments"))
	if err != nil {
		t.Fatalf("failed to read comments dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("temp file left behind after update: %s", e.Name())
		}
	}
}

// TestFileStoreWriteAtomicCleansTempOnRenameFailure は writeAtomic のRename失敗時に
// 一時ファイルが残らないことを確認する。宛先パスと同名のディレクトリを先に作っておくと
// os.Rename ( file → 既存ディレクトリ ) が失敗するため、この経路を決定的に再現できる。
func TestFileStoreWriteAtomicCleansTempOnRenameFailure(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	dir := fs.commentsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("failed to create comments dir: %v", err)
	}

	const id = "fixedid"
	// 宛先 <id>.json をディレクトリとして先取りしておく → Renameが失敗する
	if err := os.Mkdir(fs.commentPath(id), 0o755); err != nil {
		t.Fatalf("failed to pre-create blocking dir: %v", err)
	}

	err := fs.writeAtomic(Comment{ID: id, Path: "spec.md", Body: "x"})
	if err == nil {
		t.Fatal("expected writeAtomic to fail when destination is a directory")
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("failed to read comments dir: %v", err)
	}
	for _, e := range entries {
		if strings.Contains(e.Name(), ".tmp-") {
			t.Errorf("temp file left behind after rename failure: %s", e.Name())
		}
	}
}

// TestFileStoreListDeterministicOrder はcreatedAtが同値のとき、idを二次キーにして
// 決定的な昇順で返されることを確認する。
func TestFileStoreListDeterministicOrder(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	const sameTime = "2026-01-01T00:00:00Z"
	// 同一createdAtかつ辞書順が既知のidを、あえて逆順で書き込む
	for _, id := range []string{"ccc", "aaa", "bbb"} {
		if err := fs.writeAtomic(Comment{
			ID:        id,
			Version:   1,
			Path:      "spec.md",
			Body:      "c",
			CreatedAt: sameTime,
		}); err != nil {
			t.Fatalf("writeAtomic failed: %v", err)
		}
	}

	list, err := fs.List("spec.md")
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	got := []string{}
	for _, c := range list {
		got = append(got, c.ID)
	}
	want := []string{"aaa", "bbb", "ccc"}
	if len(got) != len(want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("expected deterministic order %v, got %v", want, got)
		}
	}
}

func TestFileStoreGetNotFound(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	if _, err := fs.Get("does-not-exist"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestFileStoreUpdateNotFound(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	if _, err := fs.Update("does-not-exist", "body", false, nil, true, false, false); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}

func TestFileStoreDeleteNotFound(t *testing.T) {
	rootDir := t.TempDir()
	fs := NewFileStore(rootDir)

	if err := fs.Delete("does-not-exist"); !errors.Is(err, ErrNotFound) {
		t.Errorf("expected ErrNotFound, got %v", err)
	}
}
