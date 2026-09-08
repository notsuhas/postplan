package cli

import (
	"strings"
	"testing"
)

func TestSharesGrantPreservesExistingGrants(t *testing.T) {
	calls := 0
	srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
		calls++
		if calls == 1 {
			return 200, `{"users":[{"id":"existing","role":"viewer"}],"groupIds":["group-1"]}`
		}
		return 200, `{"ok":true,"users":[{"id":"existing","role":"viewer"},{"id":"agent","role":"editor"}],"groupIds":["group-1"]}`
	})
	c, _ := newTestClient(srv.URL, "tok")
	if err := c.shares([]string{"grant", "acme/demo", "agent", "--role", "editor"}); err != nil {
		t.Fatal(err)
	}
	if len(*reqs) != 2 || (*reqs)[1].method != "PUT" || !strings.Contains(string((*reqs)[1].body), `"id":"existing"`) || !strings.Contains(string((*reqs)[1].body), `"id":"agent"`) {
		t.Fatalf("requests = %+v", *reqs)
	}
}
