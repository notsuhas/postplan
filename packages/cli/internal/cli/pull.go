package cli

import (
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// pullMarker (.postplan/pull.json) records where a `read --pull` tree came from, so a later `deploy`
// of that tree targets the same site and passes the pulled contentVersion as the CAS token.
type pullMarker struct {
	Space          string `json:"space"`
	Name           string `json:"name"`
	ContentVersion int    `json:"contentVersion"`
}

const (
	pullMarkerDir      = ".postplan"
	pullMarkerFile     = "pull.json"
	maxPullMarkerBytes = 64 * 1024
)

// readPullMarker returns the marker a prior --pull wrote under dir, or (nil,false) if absent/unreadable.
func readPullMarker(dir string) (*pullMarker, bool) {
	path := filepath.Join(dir, pullMarkerDir, pullMarkerFile)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxPullMarkerBytes {
		return nil, false
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(f, maxPullMarkerBytes+1))
	if err != nil || len(data) > maxPullMarkerBytes {
		return nil, false
	}
	var m pullMarker
	if json.Unmarshal(data, &m) != nil {
		return nil, false
	}
	return &m, true
}

func writePullMarker(dir string, m pullMarker) error {
	md := filepath.Join(dir, pullMarkerDir)
	if err := os.MkdirAll(md, 0o755); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(m, "", "  ")
	return os.WriteFile(filepath.Join(md, pullMarkerFile), data, 0o644)
}

// encodePath percent-encodes each POSIX path segment for a content-URL fetch (mirrors a browser
// request), so paths with spaces/unicode resolve.
func encodePath(file string) string {
	segs := strings.Split(strings.TrimLeft(file, "/"), "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}
