package slug

import "testing"

// `postplan deploy ./dist` must not name the site "dist" — the folder a bundler wrote to says
// nothing about what was deployed, and every project has one.
func TestNameFromDirSkipsBuildOutputNames(t *testing.T) {
	cases := map[string]string{
		"/Users/me/myproject/dist":          "myproject",
		"/Users/me/myproject/build":         "myproject",
		"/Users/me/myproject/apps/web/dist": "web",
		"/Users/me/myproject/.output":       "myproject",
		"/Users/me/myproject/public":        "myproject",
		// Nested generics collapse until something real appears.
		"/Users/me/myproject/dist/public": "myproject",
		// A meaningful leaf is left alone.
		"/Users/me/myproject":          "myproject",
		"/Users/me/reports/q3-metrics": "q3-metrics",
		// Case-insensitive: macOS and Windows users type Dist.
		"/Users/me/myproject/Dist": "myproject",
		// Trailing separators must not yield an empty name.
		"/Users/me/myproject/dist/": "myproject",
	}
	for in, want := range cases {
		if got := NameFromDir(in); got != want {
			t.Errorf("NameFromDir(%q) = %q, want %q", in, got, want)
		}
	}
}

// Every segment generic: a poor name still beats an empty one, and --name always overrides.
func TestNameFromDirFallsBackToTheLeaf(t *testing.T) {
	for _, in := range []string{"/dist", "/tmp", "dist"} {
		if got := NameFromDir(in); got == "" {
			t.Errorf("NameFromDir(%q) returned empty", in)
		}
	}
}

// The derived name still has to survive Slugify + IsValidSlug, which is what deploy.go feeds it to.
func TestNameFromDirProducesValidSlugs(t *testing.T) {
	for _, in := range []string{"/Users/me/My Project/dist", "/Users/me/myproject/dist"} {
		if s := Slugify(NameFromDir(in)); !IsValidSlug(s) {
			t.Errorf("Slugify(NameFromDir(%q)) = %q, not a valid slug", in, s)
		}
	}
}
