package cli

import (
	"strings"
	"testing"
)

func TestVersionsCommand(t *testing.T) {
	srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
		return 200, `[{"version":2,"createdAt":"now","current":true,"files":[{"path":"index.html"}]}]`
	})
	c, out := newTestClient(srv.URL, "tok")
	if err := c.versions([]string{"acme/demo"}); err != nil {
		t.Fatalf("versions: %v", err)
	}
	if !strings.Contains(out.String(), "v2 (current)") || (*reqs)[0].path != "/api/sites/acme/demo/versions" {
		t.Fatalf("output/request = %q %+v", out.String(), *reqs)
	}
}

func TestRollbackCommand(t *testing.T) {
	calls := 0
	srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
		calls++
		if calls == 1 {
			return 200, `[{"version":3,"createdAt":"now","current":true,"files":[]}]`
		}
		return 200, `{"ok":true,"version":4,"restoredFrom":1,"url":"https://g/acme/demo"}`
	})
	c, out := newTestClient(srv.URL, "tok")
	if err := c.rollback([]string{"acme/demo", "1", "--yes"}); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if len(*reqs) != 2 || (*reqs)[1].path != "/api/sites/acme/demo/versions/1/rollback" {
		t.Fatalf("requests = %+v", *reqs)
	}
	if !strings.Contains(string((*reqs)[1].body), `"expectedVersion":3`) || !strings.Contains(out.String(), "Restored v1 as v4") {
		t.Fatalf("body/output = %q %q", (*reqs)[1].body, out.String())
	}
}
