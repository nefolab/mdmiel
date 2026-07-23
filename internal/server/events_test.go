package server

import (
	"context"
	"mdmiel/internal/store"
	"mdmiel/web"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// synchronizedSSERecorder is a minimal ResponseWriter that permits the test
// goroutine to inspect an SSE stream while the handler writes it.
type synchronizedSSERecorder struct {
	mu     sync.Mutex
	header http.Header
	body   strings.Builder
}

func newSynchronizedSSERecorder() *synchronizedSSERecorder {
	return &synchronizedSSERecorder{header: make(http.Header)}
}

func (r *synchronizedSSERecorder) Header() http.Header { return r.header }

func (r *synchronizedSSERecorder) Write(b []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.Write(b)
}

func (r *synchronizedSSERecorder) WriteHeader(int) {}
func (r *synchronizedSSERecorder) Flush()          {}

func (r *synchronizedSSERecorder) bodyString() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}

func receiveRevision(t *testing.T, ch <-chan int) int {
	t.Helper()
	select {
	case rev := <-ch:
		return rev
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for revision")
		return 0
	}
}

func TestEventHub(t *testing.T) {
	revisions := make(chan int)
	hub := newEventHub()
	go hub.run(revisions)
	a, b := hub.subscribe(), hub.subscribe()
	revisions <- 1
	if got := receiveRevision(t, a); got != 1 {
		t.Fatalf("got %d", got)
	}
	if got := receiveRevision(t, b); got != 1 {
		t.Fatalf("got %d", got)
	}
	hub.unsubscribe(a)
	revisions <- 2
	if got := receiveRevision(t, b); got != 2 {
		t.Fatalf("got %d", got)
	}
	select {
	case got := <-a:
		t.Fatalf("unsubscribed client got %d", got)
	case <-time.After(30 * time.Millisecond):
	}

	// b is deliberately unread while the hub receives two revisions; its one-slot
	// buffer must retain only the most recent revision.
	revisions <- 3
	revisions <- 4
	if got := receiveRevision(t, b); got != 4 {
		t.Fatalf("slow subscriber got %d, want 4", got)
	}
	c := hub.subscribe()
	if got := receiveRevision(t, c); got != 4 {
		t.Fatalf("reconnect got %d, want 4", got)
	}
	close(revisions)
}

func TestHandleEvents(t *testing.T) {
	root := t.TempDir()
	srv, err := NewServer(root, web.Dist, store.NewFileStore(root))
	if err != nil {
		t.Fatal(err)
	}
	revisions := make(chan int, 1)
	srv.StartLiveReload(revisions)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("GET", "/api/events", nil).WithContext(ctx)
	rec := newSynchronizedSSERecorder()
	done := make(chan struct{})
	go func() { srv.handleEvents(rec, req); close(done) }()
	time.Sleep(10 * time.Millisecond)
	revisions <- 7
	deadline := time.Now().Add(time.Second)
	for !strings.Contains(rec.bodyString(), "data: 7\n\n") && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	body := rec.bodyString()
	if !strings.Contains(body, ": connected\n\n") || !strings.Contains(body, "data: 7\n\n") {
		t.Fatalf("unexpected SSE body: %q", body)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("handler did not stop after context cancellation")
	}
	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("content-type = %q", got)
	}
}
