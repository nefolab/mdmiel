// Package watch provides debounced recursive filesystem notifications.
package watch

import (
	"log"
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
}

func New(root string, isExcluded func(name string) bool) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{fsw: fsw, root: root, isExcluded: isExcluded, events: make(chan int, 1), done: make(chan struct{})}
	w.addRecursive(root)
	go w.loop()
	return w, nil
}

func (w *Watcher) Events() <-chan int { return w.events }

func (w *Watcher) addRecursive(root string) {
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			log.Printf("watch: walk %s: %v", p, err)
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
			log.Printf("watch: add %s: %v", p, err)
		}
		return nil
	})
	if err != nil {
		log.Printf("watch: walk %s: %v", root, err)
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
			log.Printf("watch: %v", err)
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
