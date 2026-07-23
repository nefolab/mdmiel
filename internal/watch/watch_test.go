package watch

import (
	"mdmiel/internal/fsutil"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func withShortDebounce(t *testing.T) {
	t.Helper()
	original := debounceInterval
	debounceInterval = 20 * time.Millisecond
	t.Cleanup(func() { debounceInterval = original })
}

func noEvent(t *testing.T, ch <-chan int) {
	t.Helper()
	select {
	case got := <-ch:
		t.Fatalf("unexpected revision %d", got)
	case <-time.After(100 * time.Millisecond):
	}
}

func event(t *testing.T, ch <-chan int) int {
	t.Helper()
	select {
	case got := <-ch:
		return got
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for revision")
		return 0
	}
}

func TestWatcher(t *testing.T) {
	withShortDebounce(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".mdmiel", "comments"), 0755); err != nil {
		t.Fatal(err)
	}
	w, err := New(root, fsutil.IsExcludedDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	t.Run("excludes comment writes", func(t *testing.T) {
		if err := os.WriteFile(filepath.Join(root, ".mdmiel", "comments", "x.json"), []byte(`{}`), 0644); err != nil {
			t.Fatal(err)
		}
		noEvent(t, w.Events())
	})

	t.Run("normal write and monotonic revisions", func(t *testing.T) {
		path := filepath.Join(root, "a.md")
		if err := os.WriteFile(path, []byte("one"), 0644); err != nil {
			t.Fatal(err)
		}
		first := event(t, w.Events())
		if err := os.WriteFile(path, []byte("two"), 0644); err != nil {
			t.Fatal(err)
		}
		second := event(t, w.Events())
		if second <= first {
			t.Fatalf("revisions not monotonic: %d then %d", first, second)
		}
	})

	t.Run("debounces bursts", func(t *testing.T) {
		path := filepath.Join(root, "burst.md")
		for i := 0; i < 10; i++ {
			if err := os.WriteFile(path, []byte("content"), 0644); err != nil {
				t.Fatal(err)
			}
		}
		event(t, w.Events())
		noEvent(t, w.Events())
	})

	t.Run("adds new directories", func(t *testing.T) {
		dir := filepath.Join(root, "sub2")
		if err := os.Mkdir(dir, 0755); err != nil {
			t.Fatal(err)
		}
		event(t, w.Events())
		time.Sleep(30 * time.Millisecond)
		if err := os.WriteFile(filepath.Join(dir, "b.md"), []byte("new"), 0644); err != nil {
			t.Fatal(err)
		}
		event(t, w.Events())
	})
}

func TestWatcherCloseIsIdempotent(t *testing.T) {
	w, err := New(t.TempDir(), fsutil.IsExcludedDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case _, ok := <-w.Events():
		if ok {
			t.Fatal("events channel is still open after Close")
		}
	case <-time.After(time.Second):
		t.Fatal("events channel was not closed after Close")
	}
}

func TestWatcherExcludesLazilyCreatedMdmielDirectory(t *testing.T) {
	withShortDebounce(t)
	root := t.TempDir()
	w, err := New(root, fsutil.IsExcludedDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	commentsDir := filepath.Join(root, ".mdmiel", "comments")
	if err := os.MkdirAll(commentsDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(commentsDir, "x.json"), []byte(`{}`), 0644); err != nil {
		t.Fatal(err)
	}
	// FileStore creates .mdmiel lazily. Its creation event must be excluded too,
	// not only writes below a directory that already existed when watching began.
	noEvent(t, w.Events())
}
