package server

import (
	"fmt"
	"net/http"
	"sync"
)

type eventHub struct {
	mu   sync.Mutex
	subs map[chan int]struct{}
	last int
}

func newEventHub() *eventHub { return &eventHub{subs: make(map[chan int]struct{})} }

func (h *eventHub) subscribe() chan int {
	ch := make(chan int, 1)
	h.mu.Lock()
	h.subs[ch] = struct{}{}
	if h.last > 0 {
		ch <- h.last
	}
	h.mu.Unlock()
	return ch
}

func (h *eventHub) unsubscribe(ch chan int) {
	h.mu.Lock()
	delete(h.subs, ch)
	h.mu.Unlock()
}

func (h *eventHub) run(revisions <-chan int) {
	for rev := range revisions {
		h.mu.Lock()
		h.last = rev
		for ch := range h.subs {
			select {
			case ch <- rev:
			default:
				select {
				case <-ch:
				default:
				}
				select {
				case ch <- rev:
				default:
				}
			}
		}
		h.mu.Unlock()
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	ch := s.hub.subscribe()
	defer s.hub.unsubscribe(ch)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case rev := <-ch:
			fmt.Fprintf(w, "data: %d\n\n", rev)
			flusher.Flush()
		}
	}
}
