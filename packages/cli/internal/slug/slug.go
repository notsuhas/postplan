package slug

import (
	"path/filepath"
	"regexp"
	"strings"
)

// Derive a Postplan site slug from a file/folder name. Mirrors the server's rule
// (api lib/slug.ts): lowercase alphanumeric + hyphens, 3-40 chars, no edge hyphen.
var (
	slugNonAlnum = regexp.MustCompile(`[^a-z0-9-]+`)
	slugDashRun  = regexp.MustCompile(`-{2,}`)
	slugRe       = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`)
)

func Slugify(raw string) string {
	s := strings.ToLower(raw)
	s = slugNonAlnum.ReplaceAllString(s, "-")
	s = slugDashRun.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 40 {
		s = s[:40]
	}
	return strings.TrimRight(s, "-")
}

func IsValidSlug(s string) bool {
	return slugRe.MatchString(s)
}

// Build-output directory names say nothing about WHAT was deployed: `postplan deploy ./dist` would
// name every site "dist", and `./build` every other one "build". When the leaf is one of these, walk
// up to the first ancestor that is not — so myproject/dist becomes "myproject" and
// myproject/apps/web/dist becomes "web".
var genericDirs = map[string]bool{
	".output": true, "artifacts": true, "build": true, "dist": true, "html": true,
	"out": true, "output": true, "public": true, "release": true, "site": true,
	"static": true, "target": true, "temp": true, "tmp": true, "www": true, "_site": true,
}

// NameFromDir derives a site name from a directory path, skipping generic build-output segments.
// Falls back to the leaf when every candidate is generic (a bare `/dist`, say) — a poor name beats
// an empty one, and --name is always available.
func NameFromDir(dir string) string {
	p := filepath.Clean(dir)
	for {
		base := filepath.Base(p)
		if base == "." || base == string(filepath.Separator) || base == "" {
			break
		}
		if !genericDirs[strings.ToLower(base)] {
			return base
		}
		parent := filepath.Dir(p)
		if parent == p {
			break
		}
		p = parent
	}
	return filepath.Base(filepath.Clean(dir))
}
