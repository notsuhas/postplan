package cli

// Dispatch-level tests: these assert how `dispatch` wires a token and base URL into the client,
// not how config.json is parsed. They lived beside the config tests only because the CLI used to
// be a single package; the helpers they need (recordingServer, capturedReq) are cli's.

import (
	"strings"
	"testing"

	"postplan/internal/config"
)

func TestDispatchTokenWiring(t *testing.T) {
	// An authed command must send POSTPLAN_TOKEN when it is set, so a CI job can deploy with an
	// API key it never wrote to disk. This is the whole point of the env override.
	t.Run("an authed command sends POSTPLAN_TOKEN over the stored token", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(*capturedReq) (int, string) { return 200, "[]" })
		t.Setenv("HOME", t.TempDir())
		if err := config.Write(config.Config{ApiUrl: srv.URL, Token: "stored-session"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("POSTPLAN_TOKEN", "glk_from-ci")

		if err := dispatch("list", nil); err != nil {
			t.Fatalf("dispatch(list): %v", err)
		}
		if len(*reqs) == 0 {
			t.Fatal("no request reached the server")
		}
		if got := (*reqs)[0].auth; got != "Bearer glk_from-ci" {
			t.Fatalf("authed command sent %q, want the env token", got)
		}
	})

	// logout is the exception, and it matters: it is a session verb. If POSTPLAN_TOKEN shadowed the
	// stored token here, logout would POST an API key, the server would 400 it (a key is revoked
	// from the keys screen), and the CLI would still delete config.json — the user's real session
	// token gone locally but still valid server-side.
	t.Run("logout sends the STORED token even when POSTPLAN_TOKEN is set", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(*capturedReq) (int, string) { return 200, `{"ok":true}` })
		t.Setenv("HOME", t.TempDir())
		if err := config.Write(config.Config{ApiUrl: srv.URL, Token: "stored-session"}); err != nil {
			t.Fatal(err)
		}
		t.Setenv("POSTPLAN_TOKEN", "glk_from-ci")

		if err := dispatch("logout", nil); err != nil {
			t.Fatalf("dispatch(logout): %v", err)
		}
		if len(*reqs) == 0 {
			t.Fatal("no request reached the server")
		}
		if got := (*reqs)[0].auth; got != "Bearer stored-session" {
			t.Fatalf("logout sent %q, want the stored session token", got)
		}
	})
}

// The env override has to be resolvable as a WHOLE credential. Before this, the token came from
// the env but the instance URL only from ~/.postplan/config.json, so a CI container with both vars
// exported and no config file passed requireAuth() on the non-empty token and then failed every
// request with `unsupported protocol scheme ""`.

func TestDispatchEnvOnlyNeedsNoConfigFile(t *testing.T) {
	srv, reqs := recordingServer(t, func(*capturedReq) (int, string) { return 200, "[]" })
	t.Setenv("HOME", t.TempDir()) // no config.json at all
	t.Setenv("POSTPLAN_API_URL", srv.URL)
	t.Setenv("POSTPLAN_TOKEN", "glk_from-ci")

	if err := dispatch("list", nil); err != nil {
		t.Fatalf("dispatch(list) with env-only credentials: %v", err)
	}
	if len(*reqs) == 0 {
		t.Fatal("no request reached the server — the env-only path did not resolve a base URL")
	}
	if got := (*reqs)[0].auth; got != "Bearer glk_from-ci" {
		t.Fatalf("sent %q, want the env token", got)
	}
}

// ...and with neither set, the clean "Not logged in" message must survive: APIBase() falls back to
// the local dev URL, so it is the empty TOKEN that requireAuth() catches, not an empty URL.

func TestDispatchWithNoCredentialsStillSaysNotLoggedIn(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	t.Setenv("POSTPLAN_API_URL", "")
	t.Setenv("POSTPLAN_TOKEN", "")

	err := dispatch("list", nil)
	if err == nil {
		t.Fatal("expected an error with no credentials")
	}
	if !strings.Contains(err.Error(), "Not logged in") {
		t.Fatalf("error = %q, want the clean \"Not logged in\" message", err)
	}
}
