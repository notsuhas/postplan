package cli

import (
	"strings"
	"testing"
	"time"
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

func TestFeedbackWait(t *testing.T) {
	t.Run("waits then claims a sent batch before returning its contents", func(t *testing.T) {
		polls := 0
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
			if r.method == "POST" {
				return 200, strings.Replace(strings.TrimSuffix(strings.TrimPrefix(feedbackJSON, "["), "]"), `"status":"queued"`, `"status":"claimed"`, 1)
			}
			polls++
			if polls == 1 {
				return 200, "[]"
			}
			return 200, feedbackJSON
		})
		c, out := newTestClient(srv.URL, "tok")
		sleeps := 0
		c.sleep = func(d time.Duration) {
			sleeps++
			if d != 5*time.Second {
				t.Fatalf("delay = %v", d)
			}
		}
		if err := c.feedback([]string{"wait", "docs/guide", "--json"}); err != nil {
			t.Fatal(err)
		}
		if sleeps != 1 || len(*reqs) != 3 {
			t.Fatalf("sleeps=%d requests=%+v", sleeps, *reqs)
		}
		if (*reqs)[0].path != "/api/feedback?site=docs%2Fguide" || (*reqs)[2].path != "/api/feedback/batch-1/claim" {
			t.Fatalf("requests=%+v", *reqs)
		}
		if !strings.Contains(out.String(), `"status":"claimed"`) || !strings.Contains(out.String(), "Tighten this heading") {
			t.Fatalf("output=%s", out.String())
		}
	})
	t.Run("claim race retries without returning unclaimed feedback", func(t *testing.T) {
		claims := 0
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) {
			if r.method == "GET" {
				return 200, feedbackJSON
			}
			claims++
			if claims == 1 {
				return 409, `{"error":"batch is not claimable"}`
			}
			return 200, strings.Replace(strings.TrimSuffix(strings.TrimPrefix(feedbackJSON, "["), "]"), `"status":"queued"`, `"status":"claimed"`, 1)
		})
		c, out := newTestClient(srv.URL, "tok")
		c.sleep = func(time.Duration) {}
		if err := c.feedback([]string{"wait", "--json"}); err != nil {
			t.Fatal(err)
		}
		if claims != 2 || !strings.Contains(out.String(), `"status":"claimed"`) {
			t.Fatalf("claims=%d output=%s", claims, out.String())
		}
	})
	t.Run("timeout emits null and never claims ordinary comments", func(t *testing.T) {
		srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) { return 200, "[]" })
		c, out := newTestClient(srv.URL, "tok")
		originalNow := timeNow
		defer func() { timeNow = originalNow }()
		now := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
		timeNow = func() time.Time { return now }
		c.sleep = func(d time.Duration) { now = now.Add(d) }
		if err := c.feedback([]string{"wait", "--timeout", "2s", "--json"}); err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(out.String()) != "null" {
			t.Fatalf("output=%s", out.String())
		}
		for _, req := range *reqs {
			if req.method != "GET" || req.path != "/api/feedback" {
				t.Fatalf("unexpected request=%+v", req)
			}
		}
	})
	t.Run("authentication failure stops the listener", func(t *testing.T) {
		srv, _ := recordingServer(t, func(r *capturedReq) (int, string) { return 401, `{"error":"unauthorized"}` })
		c, out := newTestClient(srv.URL, "tok")
		if err := c.feedback([]string{"wait", "--json"}); err == nil {
			t.Fatal("expected auth error")
		}
		if out.Len() != 0 {
			t.Fatalf("unexpected output=%s", out.String())
		}
	})
	t.Run("validates polling duration and timeout", func(t *testing.T) {
		for _, args := range [][]string{{"wait", "--interval", "0s"}, {"wait", "--interval", "nope"}, {"wait", "--timeout", "0s"}, {"wait", "invalid"}} {
			c, _ := newTestClient("http://unused.invalid", "tok")
			if err := c.feedback(args); err == nil {
				t.Fatalf("accepted %v", args)
			}
		}
	})
}
