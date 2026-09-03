package config

import (
	"os"
	"testing"
)

func TestConfigRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if got := Read(); got != nil {
		t.Fatalf("Read on empty home = %+v, want nil", got)
	}
	if err := Write(Config{ApiUrl: "https://x.example", Token: "tok"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	got := Read()
	if got == nil || got.ApiUrl != "https://x.example" || got.Token != "tok" {
		t.Fatalf("roundtrip = %+v", got)
	}
}

// A token file must never be world-readable. install.sh seeds config.json at 0644 and login
// rewrites it in place, so Write has to force 0600 on the resulting file (not just on create).
func TestConfigTokenFilePrivate(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	// Simulate install.sh seeding the config at 0644 before any login writes the token.
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(Path(), []byte(`{"apiUrl":"https://x"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Write(Config{ApiUrl: "https://x", Token: "secret"}); err != nil {
		t.Fatalf("Write: %v", err)
	}
	fi, err := os.Stat(Path())
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("config perm = %o, want 600 (token must not be world-readable)", perm)
	}
}

func TestApiBasePrecedence(t *testing.T) {
	t.Run("env-wins", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_API_URL", "https://env.example")
		_ = Write(Config{ApiUrl: "https://cfg.example"})
		if got := APIBase(); got != "https://env.example" {
			t.Fatalf("APIBase = %q", got)
		}
	})

	t.Run("blank-env-falls-through-to-config", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_API_URL", "   ") // blank -> falls through (|| not ??)
		_ = Write(Config{ApiUrl: "https://cfg.example"})
		if got := APIBase(); got != "https://cfg.example" {
			t.Fatalf("APIBase = %q", got)
		}
	})

	t.Run("default-when-nothing-set", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_API_URL", "")
		if got := APIBase(); got != "http://localhost:8787" {
			t.Fatalf("APIBase = %q", got)
		}
	})
}

func TestApiTokenPrecedence(t *testing.T) {
	t.Run("env-wins", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "env-tok")
		_ = Write(Config{ApiUrl: "https://cfg.example", Token: "cfg-tok"})
		if got := APIToken(); got != "env-tok" {
			t.Fatalf("APIToken = %q", got)
		}
	})

	t.Run("blank-env-falls-through-to-config", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "   ") // blank -> falls through (|| not ??)
		_ = Write(Config{ApiUrl: "https://cfg.example", Token: "cfg-tok"})
		if got := APIToken(); got != "cfg-tok" {
			t.Fatalf("APIToken = %q", got)
		}
	})

	t.Run("env-alone-with-no-config", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "env-tok")
		if got := APIToken(); got != "env-tok" {
			t.Fatalf("APIToken = %q", got)
		}
	})

	t.Run("empty-when-nothing-set", func(t *testing.T) {
		t.Setenv("HOME", t.TempDir())
		t.Setenv("GLANCE_TOKEN", "")
		if got := APIToken(); got != "" {
			t.Fatalf("APIToken = %q", got)
		}
	})
}

// dispatch() wiring. TestApiTokenPrecedence pins APIToken() in isolation, but nothing pinned that
// dispatch actually CALLS it — swapping both call sites for a literal "" left the whole suite
// green. These drive real commands through dispatch and assert the bearer that reaches the wire.
