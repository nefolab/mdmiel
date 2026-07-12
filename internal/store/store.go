// Package store は行コメントの永続化を抽象化する。
// MVP では FileStore ( サイドカーJSON: <rootDir>/.mdmiel/comments/<id>.json ) が唯一の実装だが、
// 将来のチーム対応でサーバー/DBストアに差し替えられるよう interface を切っている。
package store

import "errors"

// ErrNotFound は指定されたidのコメントが存在しない場合に返される。
var ErrNotFound = errors.New("comment not found")

// Anchor はコメントが紐づくソース行の位置情報。
// 行番号だけでなく前後テキストのハッシュも持たせ、ファイル更新で行がずれても
// snippet 再マッチで表示位置を補正できるようにする ( 詳細は設計書「行アンカリング設計」 )。
type Anchor struct {
	Line        int    `json:"line"`
	Snippet     string `json:"snippet"`
	SnippetHash string `json:"snippetHash"`
}

// NoteOffset はコメントの付箋UI表示位置を、アンカー基準からのドラッグ差分 ( dx, dy ) として
// 保持する。dx/dyの単位はフロントエンド側の座標系に委ねる ( サーバー側は不透明な数値として扱う )。
type NoteOffset struct {
	DX float64 `json:"dx"`
	DY float64 `json:"dy"`
}

// Comment は1件の行コメント。JSONタグはサイドカーファイルのフィールド名と一致させる ( camelCase )。
type Comment struct {
	Version    int         `json:"version"`
	ID         string      `json:"id"`
	Path       string      `json:"path"`
	Anchor     Anchor      `json:"anchor"`
	Body       string      `json:"body"`
	Author     string      `json:"author"`
	CreatedAt  string      `json:"createdAt"`
	UpdatedAt  string      `json:"updatedAt,omitempty"`
	Links      []string    `json:"links,omitempty"`
	NoteOffset *NoteOffset `json:"noteOffset,omitempty"`
	Resolved   bool        `json:"resolved"`
}

// Store は行コメントの永続化操作を抽象化する。
type Store interface {
	// List は指定されたpathに紐づくコメントをcreatedAt昇順で返す。
	List(path string) ([]Comment, error)

	// Create は id・version・createdAt・resolved をサーバー側で付与して保存し、
	// 保存後のComment ( サーバー生成フィールド込み ) を返す。
	Create(c Comment) (Comment, error)

	// Get はidを指定して単体取得する。存在しなければErrNotFoundを返す。
	Get(id string) (Comment, error)

	// Update は部分更新を行う。updateBody/updateResolved/updateOffsetで各フィールドを
	// 更新するかどうかを区別し、更新対象のみ反映してupdatedAtを付与する。
	// updateOffsetがtrueのときoffset ( nil可、付箋位置のドラッグオフセット ) をそのまま
	// NoteOffsetへ反映し、falseのときは既存のNoteOffsetを変更しない。
	// 存在しなければErrNotFoundを返す。
	Update(id string, body string, resolved bool, offset *NoteOffset, updateBody bool, updateResolved bool, updateOffset bool) (Comment, error)

	// Delete はidを指定して削除する。存在しなければErrNotFoundを返す。
	Delete(id string) error
}
