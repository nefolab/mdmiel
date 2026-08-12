package auth

import (
	"context"
	"testing"
)

func TestUserDisplayName(t *testing.T) {
	tests := []struct {
		name string
		user User
		want string
	}{
		{
			name: "name is set",
			user: User{ID: "alice@example.com", Name: "Alice"},
			want: "Alice",
		},
		{
			name: "name is empty",
			user: User{ID: "alice@example.com"},
			want: "alice@example.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.user.DisplayName(); got != tt.want {
				t.Errorf("DisplayName() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestUserContext(t *testing.T) {
	want := User{ID: "alice@example.com", Name: "Alice"}
	tests := []struct {
		name   string
		ctx    context.Context
		want   User
		wantOK bool
	}{
		{
			name:   "user is set",
			ctx:    WithUser(context.Background(), want),
			want:   want,
			wantOK: true,
		},
		{
			name: "user is not set",
			ctx:  context.Background(),
		},
		{
			name: "empty user is unauthenticated",
			ctx:  WithUser(context.Background(), User{}),
		},
		{
			name: "user without ID is unauthenticated",
			ctx:  WithUser(context.Background(), User{Name: "Alice"}),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := UserFrom(tt.ctx)
			if ok != tt.wantOK {
				t.Errorf("UserFrom() ok = %v, want %v", ok, tt.wantOK)
			}
			if got != tt.want {
				t.Errorf("UserFrom() user = %#v, want %#v", got, tt.want)
			}
		})
	}
}

func TestIsLoopbackAddr(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want bool
	}{
		{name: "IPv4 loopback", addr: "127.0.0.1:8686", want: true},
		{name: "IPv4 loopback second address", addr: "127.0.0.2:8686", want: true},
		{name: "IPv4 loopback near upper bound", addr: "127.255.255.254:8686", want: true},
		{name: "IPv6 loopback", addr: "[::1]:8686", want: true},
		{name: "IPv4 loopback without port", addr: "127.0.0.1", want: true},
		{name: "IPv4-mapped IPv6 loopback", addr: "[::ffff:127.0.0.1]:8686", want: true},
		{name: "IPv6 loopback without port", addr: "::1", want: true},
		{name: "expanded IPv6 loopback", addr: "0:0:0:0:0:0:0:1", want: true},
		{name: "bracketed IPv6 loopback without port", addr: "[::1]", want: true},
		{name: "zoned IPv6 loopback without port", addr: "::1%lo0", want: true},
		{name: "zoned IPv6 loopback", addr: "[::1%lo0]:8686", want: true},
		{name: "IPv4 unspecified", addr: "0.0.0.0:8686", want: false},
		{name: "private IPv4", addr: "192.168.1.10:8686", want: false},
		{name: "IPv4-mapped IPv6 private address", addr: "[::ffff:192.168.1.10]:8686", want: false},
		{name: "empty host", addr: ":8686", want: false},
		{name: "IPv6 unspecified", addr: "[::]:8686", want: false},
		{name: "DNS name", addr: "example.com:8686", want: false},
		{name: "localhost is not resolved", addr: "localhost:8686", want: false},
		{name: "too many colons", addr: "127.0.0.1:8686:9", want: false},
		{name: "empty address", addr: "", want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsLoopbackAddr(tt.addr); got != tt.want {
				t.Errorf("IsLoopbackAddr(%q) = %v, want %v", tt.addr, got, tt.want)
			}
		})
	}
}
