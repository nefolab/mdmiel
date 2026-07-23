// Package fsutil contains filesystem rules shared by the server and watcher.
package fsutil

import "strings"

// IsExcludedDir reports whether a directory basename should be excluded from
// the file list and live-reload watcher.
func IsExcludedDir(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules"
}
