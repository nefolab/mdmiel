// Package watch provides debounced recursive filesystem notifications.
package watch

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// debounceInterval is a variable so package tests can shorten it.
var debounceInterval = 200 * time.Millisecond

type Watcher struct {
	fsw        *fsnotify.Watcher
	root       string
	isExcluded func(name string) bool
	events     chan int
	done       chan struct{}
	closeOnce  sync.Once
	logger     *slog.Logger // Newで必ず設定される ( 既定は slog.Default() )
}

// Option は New の任意設定。検証が必要な設定を追加できるよう error を返す形にしてある。
type Option func(*Watcher) error

// WithLogger は構造化ログの出力先を注入する。未指定なら slog.Default() を使う。
func WithLogger(l *slog.Logger) Option {
	return func(w *Watcher) error {
		if l == nil {
			return errors.New("WithLogger: logger must not be nil")
		}
		w.logger = l
		return nil
	}
}

func New(root string, isExcluded func(name string) bool, opts ...Option) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	// OSリソース確保後にWatcherを組み立て、Optionを適用してから初回walkを行う。
	// 注入ロガーが初回walkのログも受け取れるよう、この順序を変えないこと。
	w := &Watcher{
		fsw:        fsw,
		root:       root,
		isExcluded: isExcluded,
		events:     make(chan int, 1),
		done:       make(chan struct{}),
		logger:     slog.Default(),
	}
	for _, opt := range opts {
		if opt == nil {
			_ = fsw.Close()
			return nil, errors.New("watch: nil option")
		}
		if err := opt(w); err != nil {
			_ = fsw.Close()
			return nil, fmt.Errorf("watch: apply option: %w", err)
		}
	}
	w.addRecursive(root)
	go w.loop()
	return w, nil
}

func (w *Watcher) Events() <-chan int { return w.events }

func (w *Watcher) addRecursive(root string) {
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			w.logger.Warn("watch: walk failed", "path", p, "err", err)
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if p != w.root && w.isExcluded(d.Name()) {
			return filepath.SkipDir
		}
		if err := w.fsw.Add(p); err != nil {
			w.logger.Warn("watch: add failed", "path", p, "err", err)
		}
		return nil
	})
	if err != nil {
		// walk関数は SkipDir と nil しか返さないため、現状この分岐には到達しない。
		w.logger.Warn("watch: walk aborted", "root", root, "err", err)
	}
}

func (w *Watcher) relevant(ev fsnotify.Event) bool {
	if ev.Op == fsnotify.Chmod {
		return false
	}
	rel, err := filepath.Rel(w.root, ev.Name)
	if err != nil {
		return false
	}
	for _, seg := range strings.Split(filepath.ToSlash(rel), "/") {
		if w.isExcluded(seg) {
			return false
		}
	}
	return true
}

func (w *Watcher) loop() {
	defer close(w.events)
	revision := 0
	timer := time.NewTimer(debounceInterval)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()

	for {
		select {
		case ev, ok := <-w.fsw.Events:
			if !ok {
				return
			}
			if !w.relevant(ev) {
				continue
			}
			if ev.Op&fsnotify.Create != 0 {
				if fi, err := os.Stat(ev.Name); err == nil && fi.IsDir() {
					w.addRecursive(ev.Name)
				}
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(debounceInterval)
		case <-timer.C:
			revision++
			select {
			case w.events <- revision:
			default:
				select {
				case <-w.events:
				default:
				}
				select {
				case w.events <- revision:
				default:
				}
			}
		case err, ok := <-w.fsw.Errors:
			if !ok {
				return
			}
			w.logger.Error("watch: watcher error", "root", w.root, "err", err)
		case <-w.done:
			return
		}
	}
}

func (w *Watcher) Close() error {
	var err error
	w.closeOnce.Do(func() {
		close(w.done)
		err = w.fsw.Close()
	})
	return err
}
