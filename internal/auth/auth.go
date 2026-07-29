// Package auth は認証の差し込み口を提供する。
// mdmiel本体は認証方式を持たず、認証ミドルウェアを外から差し込む。
package auth

import (
	"context"
	"net/http"
	"net/netip"
	"strings"
)

// Middleware は認証の差し込み口。
type Middleware = func(http.Handler) http.Handler

// User は認証済みID。
type User struct {
	ID   string
	Name string
}

// DisplayName は表示名を返す。Name が空の場合は ID を返す。
func (u User) DisplayName() string {
	if u.Name != "" {
		return u.Name
	}
	return u.ID
}

type userCtxKey struct{}

// WithUser は認証済みIDをcontextに載せる。
func WithUser(ctx context.Context, u User) context.Context {
	return context.WithValue(ctx, userCtxKey{}, u)
}

// UserFrom はcontextから認証済みIDを取り出す。
// 未設定またはIDが空のUserは未認証として扱い、ok=falseを返す。
func UserFrom(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userCtxKey{}).(User)
	if !ok || u.ID == "" {
		return User{}, false
	}
	return u, true
}

// IsLoopbackAddr はIPリテラルのバインドアドレスがループバックかを判定する。
// DNS解決は行わず、解析できない入力はすべてfalseを返すfail-closedな判定である。
// IPv4-mapped IPv6は、その表記でバインドしても実効的にIPv4の127.0.0.1へ束縛され、
// ループバック限定が保たれるためループバックとして扱う。
func IsLoopbackAddr(addr string) bool {
	if addrPort, err := netip.ParseAddrPort(addr); err == nil {
		return addrPort.Addr().IsLoopback()
	}

	host := addr
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = host[1 : len(host)-1]
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.IsLoopback()
}
