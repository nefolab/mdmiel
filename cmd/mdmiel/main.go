package main

import (
	"flag"
	"fmt"
	"log/slog"
	"mdmiel/internal/fsutil"
	"mdmiel/internal/server"
	"mdmiel/internal/store"
	"mdmiel/internal/watch"
	"mdmiel/web"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func main() {
	// server.NewServer と watch.New は構築時に slog.Default() を掴むため、
	// SetDefault は run より前に呼ぶこと。順序を入れ替えると、それらだけが
	// 既定ハンドラを掴んだまま静かに壊れる。
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, nil)))
	os.Exit(run(os.Args[1:]))
}

// run は終了コードを返す。異常時はその場で理由をログに出し、1を返す。
// ロガーは slog.Default() から取得するため、呼び出し前に SetDefault 済みであること。
//
// 不正フラグを渡すと flag.ExitOnError によりプロセスが exit 2 する。
// 有効なディレクトリは ListenAndServe でブロックするため、テストから直接呼ぶ場合はどちらも渡してはならない。
func run(args []string) int {
	logger := slog.Default()
	// サブコマンドは持たない ( 閲覧サーバーの起動が唯一の動作 )。機能追加はweb UI側で行う方針
	fs := flag.NewFlagSet("mdmiel", flag.ExitOnError)
	port := fs.String("port", "8686", "Port to bind HTTP server")

	// flag は最初の非フラグ引数でパースを止めるため、
	// "mdmiel <dir> --port N" と "mdmiel --port N <dir>" の両形式に対応できるよう
	// フラグと位置引数を事前に振り分けてから 1 回だけパースする
	var flagArgs, posArgs []string
	rest := args
	for i := 0; i < len(rest); i++ {
		arg := rest[i]
		if strings.HasPrefix(arg, "-") {
			flagArgs = append(flagArgs, arg)
			// "--port 8686" のように値が別引数で続く形式を拾う
			// ( 現状のフラグはすべて値必須のため、この判定で安全 )
			if !strings.Contains(arg, "=") && i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "-") {
				i++
				flagArgs = append(flagArgs, rest[i])
			}
		} else {
			posArgs = append(posArgs, arg)
		}
	}

	if err := fs.Parse(flagArgs); err != nil {
		// flag.ExitOnError は Parse 内で exit 2 するため、この分岐には到達しない。
		logger.Error("failed to parse flags", "err", err)
		return 1
	}

	// 位置引数の確認
	if len(posArgs) < 1 {
		fmt.Fprintln(os.Stderr, "Error: directory is required")
		printUsage()
		return 1
	}

	targetDir := posArgs[0]
	absDir, err := filepath.Abs(targetDir)
	if err != nil {
		logger.Error("failed to resolve absolute path", "path", targetDir, "err", err)
		return 1
	}

	// ディレクトリ存在チェック
	info, err := os.Stat(absDir)
	if err != nil {
		logger.Error("failed to read directory", "root", absDir, "err", err)
		return 1
	}
	if !info.IsDir() {
		logger.Error("path is not a directory", "root", absDir)
		return 1
	}

	// サーバーインスタンス生成 ( コメントはrootDir配下の.mdmiel/comments/にFileStoreで永続化 )
	fileStore := store.NewFileStore(absDir)

	// エディタで開く機能のURLスキーム。フラグではなく環境変数にしてあるのは、
	// 上の引数振り分けループを触らずに済ませるためと、認証の MDMIEL_AUTH_BASIC /
	// MDMIEL_PUBLIC_ORIGIN と設定手段を揃えるため。未設定ならサーバー既定 ( vscode )。
	var opts []server.Option
	if scheme := os.Getenv("MDMIEL_EDITOR_SCHEME"); scheme != "" {
		opts = append(opts, server.WithEditorScheme(scheme))
	}

	srv, err := server.NewServer(absDir, web.Dist, fileStore, opts...)
	if err != nil {
		logger.Error("failed to create server", "root", absDir, "err", err)
		return 1
	}
	w, err := watch.New(absDir, fsutil.IsExcludedDir)
	if err != nil {
		logger.Warn("live reload disabled", "root", absDir, "err", err)
	} else {
		defer w.Close()
		srv.StartLiveReload(w.Events())
	}

	handler := srv.Handler()

	addr := fmt.Sprintf("127.0.0.1:%s", *port)
	url := fmt.Sprintf("http://%s/", addr)

	logger.Info("starting mdmiel server", "addr", addr, "url", url, "root", absDir)

	// ブラウザ自動起動処理
	go func() {
		// サーバーの起動待ちのために少しスリープ
		time.Sleep(100 * time.Millisecond)
		openBrowser(url, logger)
	}()

	if err := http.ListenAndServe(addr, handler); err != nil {
		logger.Error("server stopped with error", "addr", addr, "err", err)
		return 1
	}
	return 0
}

func printUsage() {
	fmt.Println("Usage:")
	fmt.Println("  mdmiel <dir> [--port 8686]")
}

func openBrowser(url string, logger *slog.Logger) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default: // linux 等
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		logger.Warn("failed to open browser", "url", url, "err", err)
	}
}
