package main

import (
	"bytes"
	"errors"
	"log"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

const helperProcessEnv = "MDMIEL_TEST_HELPER"

// TestMain は helper-process モードを提供する。
// MDMIEL_TEST_HELPER=1 のとき、テスト本体ではなく run() を実行して終了する。
func TestMain(m *testing.M) {
	if os.Getenv(helperProcessEnv) == "1" {
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
		os.Exit(run(os.Args[1:]))
	}
	os.Exit(m.Run())
}

func TestRunExitCodes(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing")
	file := filepath.Join(t.TempDir(), "file.md")
	if err := os.WriteFile(file, []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}

	// 不正フラグはテストプロセスを exit 2 にし、有効なディレクトリは
	// ListenAndServe でブロックするため、ここでは早期失敗だけを直接検証する。
	tests := []struct {
		name string
		args []string
	}{
		{name: "missing directory", args: []string{missing}},
		{name: "not a directory", args: []string{file}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := run(tt.args); got != 1 {
				t.Fatalf("run() = %d, want 1", got)
			}
		})
	}
}

func TestRunLogsFailureAttributes(t *testing.T) {
	oldDefault := slog.Default()
	oldWriter := log.Writer()
	oldFlags := log.Flags()
	var buf bytes.Buffer
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() {
		slog.SetDefault(oldDefault)
		log.SetOutput(oldWriter)
		log.SetFlags(oldFlags)
	})

	missing := filepath.Join(t.TempDir(), "missing")
	_, statErr := os.Stat(missing)
	if statErr == nil {
		t.Fatal("Stat unexpectedly succeeded")
	}
	if got := run([]string{missing}); got != 1 {
		t.Fatalf("run() = %d, want 1", got)
	}
	record := strings.TrimSpace(buf.String())
	if strings.Contains(record, "\n") {
		t.Fatalf("log contains multiple records: %s", buf.String())
	}
	for _, want := range []string{
		"level=ERROR",
		`msg="failed to read directory"`,
	} {
		if !strings.Contains(record, want) {
			t.Errorf("log does not contain %q: %s", want, record)
		}
	}
	for key, value := range map[string]string{
		"root": missing,
		"err":  statErr.Error(),
	} {
		if !containsLogAttribute(record, key, value) {
			t.Errorf("log does not contain %s=%q: %s", key, value, record)
		}
	}
}

func containsLogAttribute(line, key, value string) bool {
	prefix := key + "="
	padded := " " + line + " "
	return strings.Contains(padded, " "+prefix+value+" ") ||
		strings.Contains(padded, " "+prefix+strconv.Quote(value)+" ")
}

func TestMainInvalidFlagExitCode(t *testing.T) {
	cmd := exec.Command(os.Args[0], "--nope", "/tmp")
	cmd.Env = append(os.Environ(), helperProcessEnv+"=1")
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("helper error = %v, want *exec.ExitError", err)
	}
	if got := exitErr.ExitCode(); got != 2 {
		t.Fatalf("exit code = %d, want 2", got)
	}
}

func TestMainNoArgsUsage(t *testing.T) {
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), helperProcessEnv+"=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("helper error = %v, want *exec.ExitError", err)
	}
	if got := exitErr.ExitCode(); got != 1 {
		t.Fatalf("exit code = %d, want 1", got)
	}
	if got, want := stderr.String(), "Error: directory is required\n"; got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
	if got, want := stdout.String(), "Usage:\n  mdmiel <dir> [--port 8686]\n"; got != want {
		t.Errorf("stdout = %q, want %q", got, want)
	}
}
