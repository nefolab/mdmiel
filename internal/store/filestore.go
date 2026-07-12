package store

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"sort"
	"time"
)

// FileStore はコメントを <rootDir>/.mdmiel/comments/<id>.json に1コメント=1ファイルで
// 保存するStore実装。Gitでのチーム共有時にマージコンフリクトを避けるための構成 ( 設計書参照 )。
type FileStore struct {
	rootDir string
}

// NewFileStore は rootDir 配下の .mdmiel/comments/ を保存先とするFileStoreを作る。
// ディレクトリは初回書き込み時に遅延作成されるため、ここでは作成しない。
func NewFileStore(rootDir string) *FileStore {
	return &FileStore{rootDir: rootDir}
}

func (fs *FileStore) commentsDir() string {
	return filepath.Join(fs.rootDir, ".mdmiel", "comments")
}

func (fs *FileStore) commentPath(id string) string {
	return filepath.Join(fs.commentsDir(), id+".json")
}

// List はcommentsDir配下の全ファイルを走査し、pathが一致するコメントのみを
// createdAt昇順で返す。ディレクトリが未作成 ( コメントが1件も無い ) 場合は空スライスを返す。
func (fs *FileStore) List(path string) ([]Comment, error) {
	dir := fs.commentsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []Comment{}, nil
		}
		return nil, err
	}

	comments := make([]Comment, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".json" {
			// tmpファイル ( .json.tmp-<rand> ) やディレクトリは無視する
			continue
		}

		data, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}

		var c Comment
		if err := json.Unmarshal(data, &c); err != nil {
			continue
		}

		if c.Path == path {
			comments = append(comments, c)
		}
	}

	// createdAtは秒精度の文字列で同値になり得る。sort.Sliceは非安定のため、
	// 同値時はidを二次キーにして決定的な昇順を保証する。
	sort.Slice(comments, func(i, j int) bool {
		if comments[i].CreatedAt != comments[j].CreatedAt {
			return comments[i].CreatedAt < comments[j].CreatedAt
		}
		return comments[i].ID < comments[j].ID
	})

	return comments, nil
}

// Create はサーバー生成フィールド ( id・version・createdAt・resolved ) を付与して
// アトミックに保存する。authorが空の場合はOSユーザー名で補完する ( MVPの暫定仕様 )。
func (fs *FileStore) Create(c Comment) (Comment, error) {
	id, err := newID()
	if err != nil {
		return Comment{}, err
	}

	c.ID = id
	c.Version = 1
	c.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	c.UpdatedAt = ""
	c.Resolved = false
	if c.Author == "" {
		c.Author = currentOSUser()
	}

	if err := fs.writeAtomic(c); err != nil {
		return Comment{}, err
	}
	return c, nil
}

// Get はidを指定して単体取得する。存在しなければErrNotFoundを返す。
func (fs *FileStore) Get(id string) (Comment, error) {
	data, err := os.ReadFile(fs.commentPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return Comment{}, ErrNotFound
		}
		return Comment{}, err
	}

	var c Comment
	if err := json.Unmarshal(data, &c); err != nil {
		return Comment{}, err
	}
	return c, nil
}

// Update は既存コメントを読み込み、updateBody/updateResolved/updateOffsetで指定された
// フィールドのみ上書きしてupdatedAtを付与のうえアトミックに保存する。
func (fs *FileStore) Update(id string, body string, resolved bool, offset *NoteOffset, updateBody bool, updateResolved bool, updateOffset bool) (Comment, error) {
	c, err := fs.Get(id)
	if err != nil {
		return Comment{}, err
	}

	if updateBody {
		c.Body = body
	}
	if updateResolved {
		c.Resolved = resolved
	}
	if updateOffset {
		c.NoteOffset = offset
	}
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if err := fs.writeAtomic(c); err != nil {
		return Comment{}, err
	}
	return c, nil
}

// Delete はidに対応するコメントファイルを削除する。存在しなければErrNotFoundを返す。
func (fs *FileStore) Delete(id string) error {
	if err := os.Remove(fs.commentPath(id)); err != nil {
		if os.IsNotExist(err) {
			return ErrNotFound
		}
		return err
	}
	return nil
}

// writeAtomic は同ディレクトリの一時ファイル ( <id>.json.tmp-<rand> ) に書き込んでから
// os.Renameで本ファイルへ置き換える。途中クラッシュしても破損した本ファイルを残さない。
func (fs *FileStore) writeAtomic(c Comment) error {
	dir := fs.commentsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}

	suffix, err := randomHex(8)
	if err != nil {
		return err
	}
	tmpPath := filepath.Join(dir, fmt.Sprintf("%s.json.tmp-%s", c.ID, suffix))

	// Rename成功時以外 ( WriteFile失敗・Rename失敗・途中return ) はtempを掃除する。
	// Rename成功後はtmpPathがもう存在しないためRemoveは空振り ( 無害 ) になる。
	renamed := false
	defer func() {
		if !renamed {
			os.Remove(tmpPath)
		}
	}()

	if err := os.WriteFile(tmpPath, data, 0o644); err != nil {
		return err
	}

	if err := os.Rename(tmpPath, fs.commentPath(c.ID)); err != nil {
		return err
	}
	renamed = true
	return nil
}

// newID はcrypto/randで16バイト生成し、UUIDv4形式 ( 8-4-4-4-12、hex ) の文字列にする。
// 外部uuidライブラリは使わない。
func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// RFC4122に沿ってバージョン(4)とバリアントビットを設定する
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// randomHex はn バイトのランダム値をhex文字列にする ( 一時ファイル名のサフィックス用 )。
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return fmt.Sprintf("%x", b), nil
}

// currentOSUser はOSのユーザー名を返す ( author未指定時のMVP暫定フォールバック )。
func currentOSUser() string {
	if u, err := user.Current(); err == nil && u.Username != "" {
		return u.Username
	}
	if v := os.Getenv("USER"); v != "" {
		return v
	}
	return "unknown"
}
