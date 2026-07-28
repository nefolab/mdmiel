package watch

import (
	"bytes"
	"errors"
	"log"
	"log/slog"
	"mdmiel/internal/fsutil"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/fsnotify/fsnotify"
)

// synchronizedLogBuffer は loop goroutine の書き込みとテストgoroutineの読み取りを直列化する。
type synchronizedLogBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *synchronizedLogBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *synchronizedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type logAttribute struct {
	key   string
	value string
}

func containsLogAttribute(line string, attr logAttribute) bool {
	prefix := attr.key + "="
	padded := " " + line + " "
	return strings.Contains(padded, " "+prefix+attr.value+" ") ||
		strings.Contains(padded, " "+prefix+strconv.Quote(attr.value)+" ")
}

func matchesLogRecord(line string, want []string, attrs []logAttribute) bool {
	for _, s := range want {
		if !strings.Contains(line, s) {
			return false
		}
	}
	for _, attr := range attrs {
		if !containsLogAttribute(line, attr) {
			return false
		}
	}
	return true
}

// waitForLog は同一レコードに want と attrs がすべて現れるまで最大1秒ポーリングする。
func waitForLog(t *testing.T, b *synchronizedLogBuffer, want []string, attrs ...logAttribute) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, line := range strings.Split(b.String(), "\n") {
			if matchesLogRecord(line, want, attrs) {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("log did not contain one record with %q and %+v: %s", want, attrs, b.String())
}

func closeWatcherAndWait(t *testing.T, w *Watcher) {
	t.Helper()
	if err := w.Close(); err != nil {
		t.Error(err)
	}
	timeout := time.After(time.Second)
	for {
		select {
		case _, ok := <-w.Events():
			if !ok {
				return
			}
		case <-timeout:
			t.Fatal("events channel was not closed after Close")
		}
	}
}

func TestWatcherLogsWalkFailure(t *testing.T) {
	root := t.TempDir()
	var buf synchronizedLogBuffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	w, err := New(root, fsutil.IsExcludedDir, WithLogger(logger))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeWatcherAndWait(t, w) })

	missing := filepath.Join(root, "missing")
	_, walkErr := os.Lstat(missing)
	if walkErr == nil {
		t.Fatal("Lstat unexpectedly succeeded")
	}
	w.addRecursive(missing)
	waitForLog(t, &buf,
		[]string{"level=WARN", `msg="watch: walk failed"`},
		logAttribute{key: "path", value: missing},
		logAttribute{key: "err", value: walkErr.Error()},
	)
}

func TestWatcherLogsAddFailure(t *testing.T) {
	root := t.TempDir()
	var buf synchronizedLogBuffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	w, err := New(root, fsutil.IsExcludedDir, WithLogger(logger))
	if err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeWatcherAndWait(t, w) })

	w.addRecursive(root)
	waitForLog(t, &buf,
		[]string{"level=WARN", `msg="watch: add failed"`},
		logAttribute{key: "path", value: root},
		logAttribute{key: "err", value: fsnotify.ErrClosed.Error()},
	)
}

func TestWatcherSurvivesWatcherErrors(t *testing.T) {
	withShortDebounce(t)
	root := t.TempDir()
	var buf synchronizedLogBuffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	w, err := New(root, fsutil.IsExcludedDir, WithLogger(logger))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeWatcherAndWait(t, w) })

	for _, message := range []string{"injected 1", "injected 2", "injected 3"} {
		err := errors.New(message)
		select {
		case w.fsw.Errors <- err:
		case <-time.After(time.Second):
			t.Fatalf("timed out sending watcher error %q", message)
		}
	}
	for _, message := range []string{"injected 1", "injected 2", "injected 3"} {
		waitForLog(t, &buf,
			[]string{"level=ERROR", `msg="watch: watcher error"`},
			logAttribute{key: "root", value: root},
			logAttribute{key: "err", value: message},
		)
	}

	if err := os.WriteFile(filepath.Join(root, "after-errors.md"), []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}
	event(t, w.Events())
}

func TestWatcherUsesDefaultLoggerWhenUnset(t *testing.T) {
	oldDefault := slog.Default()
	oldWriter := log.Writer()
	oldFlags := log.Flags()
	var buf synchronizedLogBuffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() {
		slog.SetDefault(oldDefault)
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
	})

	root := t.TempDir()
	w, err := New(root, fsutil.IsExcludedDir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeWatcherAndWait(t, w) })

	missing := filepath.Join(root, "missing")
	w.addRecursive(missing)
	waitForLog(t, &buf,
		[]string{`msg="watch: walk failed"`},
		logAttribute{key: "path", value: missing},
	)
}

func TestWatchWithLoggerNilReturnsError(t *testing.T) {
	w, err := New(t.TempDir(), fsutil.IsExcludedDir, WithLogger(nil))
	if err == nil {
		t.Fatal("New succeeded with a nil logger")
	}
	if w != nil {
		t.Fatal("New returned a watcher with a nil logger")
	}
}

func TestWatchNewNilOptionReturnsError(t *testing.T) {
	w, err := New(t.TempDir(), fsutil.IsExcludedDir, nil)
	if err == nil {
		t.Fatal("New succeeded with a nil option")
	}
	if w != nil {
		t.Fatal("New returned a watcher with a nil option")
	}
}
