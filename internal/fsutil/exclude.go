// Package fsutil contains filesystem rules shared by the server and watcher.
package fsutil

import "strings"

// IsExcludedDir reports whether a directory basename should be excluded from
// the file list and live-reload watcher.
func IsExcludedDir(name string) bool {
	return strings.HasPrefix(name, ".") || name == "node_modules"
}

// IsExcludedFile reports whether a file basename should be excluded from the
// file list.
//
// server.ResolveSecurePath rejects every "."-prefixed path segment, so a
// dot-prefixed file that reaches the list would 403 the moment it is opened.
// Both rules must stay in sync or the sidebar grows entries that cannot load.
func IsExcludedFile(name string) bool {
	return strings.HasPrefix(name, ".")
}
