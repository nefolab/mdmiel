package main

import (
	"flag"
	"fmt"
	"log"
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
	// サブコマンドは持たない ( 閲覧サーバーの起動が唯一の動作 )。機能追加はweb UI側で行う方針
	fs := flag.NewFlagSet("mdmiel", flag.ExitOnError)
	port := fs.String("port", "8686", "Port to bind HTTP server")

	// flag は最初の非フラグ引数でパースを止めるため、
	// "mdmiel <dir> --port N" と "mdmiel --port N <dir>" の両形式に対応できるよう
	// フラグと位置引数を事前に振り分けてから 1 回だけパースする
	var flagArgs, posArgs []string
	rest := os.Args[1:]
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
		log.Fatalf("failed to parse flags: %v", err)
	}

	// 位置引数の確認
	if len(posArgs) < 1 {
		fmt.Fprintln(os.Stderr, "Error: directory is required")
		printUsage()
		os.Exit(1)
	}

	targetDir := posArgs[0]
	absDir, err := filepath.Abs(targetDir)
	if err != nil {
		log.Fatalf("failed to get absolute path of directory: %v", err)
	}

	// ディレクトリ存在チェック
	info, err := os.Stat(absDir)
	if err != nil {
		log.Fatalf("failed to read directory: %v", err)
	}
	if !info.IsDir() {
		log.Fatalf("path is not a directory: %s", absDir)
	}

	// サーバーインスタンス生成 ( コメントはrootDir配下の.mdmiel/comments/にFileStoreで永続化 )
	fileStore := store.NewFileStore(absDir)
	srv, err := server.NewServer(absDir, web.Dist, fileStore)
	if err != nil {
		log.Fatalf("failed to create server: %v", err)
	}
	w, err := watch.New(absDir, fsutil.IsExcludedDir)
	if err != nil {
		log.Printf("live reload disabled: %v", err)
	} else {
		defer w.Close()
		srv.StartLiveReload(w.Events())
	}

	handler := srv.Handler()

	addr := fmt.Sprintf("127.0.0.1:%s", *port)
	url := fmt.Sprintf("http://%s/", addr)

	log.Printf("Starting mdmiel server on %s", url)
	log.Printf("Serving files from: %s", absDir)

	// ブラウザ自動起動処理
	go func() {
		// サーバーの起動待ちのために少しスリープ
		time.Sleep(100 * time.Millisecond)
		openBrowser(url)
	}()

	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("server stopped with error: %v", err)
	}
}

func printUsage() {
	fmt.Println("Usage:")
	fmt.Println("  mdmiel <dir> [--port 8686]")
}

func openBrowser(url string) {
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
		log.Printf("failed to open browser: %v", err)
	}
}
