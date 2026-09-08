package cli

import (
	"strings"
	"testing"
)

const feedbackJSON = `[{"id":"batch-1","site":{"space":"docs","slug":"guide"},"siteVersion":4,"status":"queued","claimableAt":"2026-09-08T12:00:05Z","createdAt":"2026-09-08T12:00:00Z","claimedAt":null,"completedAt":null,"cancelledAt":null,"completedVersion":null,"items":[{"commentId":"comment-1","threadId":"thread-1","page":"index.html","selector":"#hero h1","sourceContext":{"tag":"h1"},"anchorType":"element","anchorStatus":"anchored","quote":null,"author":{"id":"u1","name":"Ada"},"text":"Tighten this heading","version":4,"anchorVersion":4,"createdAt":"2026-09-08T11:59:00Z"}]}]`

func TestFeedbackCommands(t *testing.T) {
	t.Run("list emits stable server JSON and scopes by site", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, feedbackJSON })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.feedback([]string{"list", "docs/guide", "--json"}); err != nil {
			t.Fatal(err)
		}
		if (*reqs)[0].method != "GET" || (*reqs)[0].path != "/api/feedback?site=docs%2Fguide" {
			t.Fatalf("request = %+v", (*reqs)[0])
		}
		if strings.TrimSpace(out.String()) != feedbackJSON {
			t.Fatalf("json changed:\n%s", out.String())
		}
	})

	t.Run("claim posts with an idempotency key", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, strings.TrimSuffix(strings.TrimPrefix(feedbackJSON, "["), "]")
		})
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.feedback([]string{"claim", "batch-1", "--idempotency-key", "claim-run-1", "--json"}); err != nil {
			t.Fatal(err)
		}
		if (*reqs)[0].method != "POST" || (*reqs)[0].path != "/api/feedback/batch-1/claim" {
			t.Fatalf("request = %+v", (*reqs)[0])
		}
	})

	t.Run("complete links the deployment version", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			return 200, strings.TrimSuffix(strings.TrimPrefix(feedbackJSON, "["), "]")
		})
		c, _ := newTestClient(srv.URL, "tok")
		if err := c.feedback([]string{"complete", "batch-1", "--version", "5", "--idempotency-key", "done-run-1"}); err != nil {
			t.Fatal(err)
		}
		if got := string((*reqs)[0].body); got != `{"version":5}` {
			t.Fatalf("body = %s", got)
		}
	})
}
