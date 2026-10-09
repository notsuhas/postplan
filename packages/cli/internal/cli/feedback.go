package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"postplan/internal/argparse"
	"strconv"
	"strings"
	"time"
)

type feedbackAuthor struct {
	ID   *string `json:"id"`
	Name string  `json:"name"`
}

type feedbackItem struct {
	CommentID     string          `json:"commentId"`
	ThreadID      string          `json:"threadId"`
	Page          string          `json:"page"`
	Selector      *string         `json:"selector"`
	SourceContext json.RawMessage `json:"sourceContext"`
	AnchorType    string          `json:"anchorType"`
	AnchorStatus  string          `json:"anchorStatus"`
	Quote         *string         `json:"quote"`
	Author        feedbackAuthor  `json:"author"`
	Text          string          `json:"text"`
	Version       int             `json:"version"`
	AnchorVersion int             `json:"anchorVersion"`
	CreatedAt     string          `json:"createdAt"`
}

type feedbackSite struct {
	Space string `json:"space"`
	Slug  string `json:"slug"`
}

type feedbackBatch struct {
	ID               string         `json:"id"`
	Site             feedbackSite   `json:"site"`
	SiteVersion      int            `json:"siteVersion"`
	Status           string         `json:"status"`
	ClaimableAt      string         `json:"claimableAt"`
	CreatedAt        string         `json:"createdAt"`
	ClaimedAt        *string        `json:"claimedAt"`
	CompletedAt      *string        `json:"completedAt"`
	CancelledAt      *string        `json:"cancelledAt"`
	CompletedVersion *int           `json:"completedVersion"`
	Items            []feedbackItem `json:"items"`
}

const feedbackUsage = "Usage: postplan feedback list [space/site] [--json] | wait [space/site] [--interval <duration>] [--timeout <duration>] [--json] | claim <batch-id> [--idempotency-key <key>] [--json] | complete <batch-id> [--version <n>] [--idempotency-key <key>] [--json]"

func (c *client) feedback(argv []string) error {
	if len(argv) == 0 {
		return fmt.Errorf(feedbackUsage)
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	switch argv[0] {
	case "list":
		return c.feedbackList(argv[1:])
	case "wait":
		return c.feedbackWait(argv[1:])
	case "claim":
		return c.feedbackClaim(argv[1:])
	case "complete":
		return c.feedbackComplete(argv[1:])
	default:
		return fmt.Errorf(feedbackUsage)
	}
}

func (c *client) feedbackList(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json"); err != nil || len(positional) > 1 {
		return fmt.Errorf(feedbackUsage)
	}
	batches, err := c.fetchFeedback(c.ctx, positional)
	if err != nil {
		return err
	}
	if flags["json"] == true {
		return json.NewEncoder(c.out).Encode(batches)
	}
	if len(batches) == 0 {
		fmt.Fprintln(c.out, "No feedback batches.")
		return nil
	}
	for _, batch := range batches {
		fmt.Fprintf(c.out, "%s  %s/%s v%d  %d comments\n", batch.ID, batch.Site.Space, batch.Site.Slug, batch.SiteVersion, len(batch.Items))
	}
	return nil
}

// fetchFeedback reads only reviewer-sent, claimable batches; ordinary comments are never polled.
func (c *client) fetchFeedback(ctx context.Context, positional []string) ([]feedbackBatch, error) {
	path := "/api/feedback"
	if len(positional) == 1 {
		if _, _, err := splitSpaceSlug(positional[0]); err != nil {
			return nil, fmt.Errorf(feedbackUsage)
		}
		path += "?site=" + url.QueryEscape(positional[0])
	}
	resp, err := c.authedContext(ctx, "GET", path, nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return nil, fmt.Errorf("Could not list feedback (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var batches []feedbackBatch
	if err := json.NewDecoder(resp.Body).Decode(&batches); err != nil {
		return nil, err
	}
	return batches, nil
}

// wait hands one atomically claimed batch back to the calling agent, then exits. The agent
// handles and completes that batch before waiting again, rather than claiming work ahead of time.
func (c *client) feedbackWait(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json", "interval", "timeout"); err != nil || len(positional) > 1 {
		return fmt.Errorf(feedbackUsage)
	}
	if len(positional) == 1 {
		if _, _, err := splitSpaceSlug(positional[0]); err != nil {
			return fmt.Errorf(feedbackUsage)
		}
	}
	interval := 5 * time.Second
	if raw, present := flags["interval"]; present {
		value, ok := raw.(string)
		parsed, err := time.ParseDuration(value)
		if !ok || err != nil || parsed < time.Second {
			return fmt.Errorf("--interval must be a duration of at least 1s")
		}
		interval = parsed
	}
	var deadline time.Time
	ctx := c.ctx
	if raw, present := flags["timeout"]; present {
		value, ok := raw.(string)
		timeout, err := time.ParseDuration(value)
		if !ok || err != nil || timeout <= 0 {
			return fmt.Errorf("--timeout must be a positive duration")
		}
		deadline = timeNow().Add(timeout)
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	timeoutResult := func() error {
		if flags["json"] == true {
			return json.NewEncoder(c.out).Encode(nil)
		}
		fmt.Fprintln(c.out, "No feedback received before timeout.")
		return nil
	}
	for {
		if !deadline.IsZero() && !timeNow().Before(deadline) {
			return timeoutResult()
		}
		batches, err := c.fetchFeedback(ctx, positional)
		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return timeoutResult()
			}
			return err
		}
		for _, candidate := range batches {
			if !deadline.IsZero() && !timeNow().Before(deadline) {
				return timeoutResult()
			}
			// A cancelled or timed-out wait must never claim: nobody is left to receive the batch.
			if ctx.Err() == context.DeadlineExceeded {
				return timeoutResult()
			} else if err := ctx.Err(); err != nil {
				return err
			}
			claimKey := operationKey(nil, "wait-claim")
			resp, err := c.authedContext(ctx, "POST", "/api/feedback/"+url.PathEscape(candidate.ID)+"/claim", strings.NewReader(""), map[string]string{"Idempotency-Key": claimKey})
			if err != nil {
				return claimRecoveryError(candidate.ID, claimKey, err)
			}
			if resp.StatusCode == http.StatusConflict {
				// Another agent claimed it, or the site changed. Re-list instead of acting on stale work.
				resp.Body.Close()
				continue
			}
			if !ok(resp) {
				detail := bodySlice(resp)
				resp.Body.Close()
				return claimRecoveryError(candidate.ID, claimKey, fmt.Errorf("claim request failed (%d): %s", resp.StatusCode, detail))
			}
			var batch feedbackBatch
			err = json.NewDecoder(resp.Body).Decode(&batch)
			resp.Body.Close()
			if err != nil {
				return claimRecoveryError(candidate.ID, claimKey, fmt.Errorf("claim response could not be read: %w", err))
			}
			if flags["json"] == true {
				return json.NewEncoder(c.out).Encode(batch)
			}
			fmt.Fprintf(c.out, "✓ Claimed feedback batch %s (%d comments)\n", batch.ID, len(batch.Items))
			return nil
		}
		delay := interval
		if !deadline.IsZero() {
			remaining := deadline.Sub(timeNow())
			if remaining <= 0 {
				return timeoutResult()
			}
			if remaining < delay {
				delay = remaining
			}
		}
		c.sleep(delay)
	}
}

type feedbackClaimRecoveryError struct {
	batchID string
	key     string
	err     error
}

func (e *feedbackClaimRecoveryError) Error() string {
	return fmt.Sprintf("Feedback %s may have been claimed; retry postplan feedback claim %s --idempotency-key %s to recover: %v", e.batchID, e.batchID, e.key, e.err)
}

func (e *feedbackClaimRecoveryError) Unwrap() error { return e.err }

func claimRecoveryError(batchID, key string, err error) error {
	return &feedbackClaimRecoveryError{batchID: batchID, key: key, err: err}
}

func (c *client) feedbackBatchByID(id string) (*feedbackBatch, error) {
	resp, err := c.authed("GET", "/api/feedback/"+url.PathEscape(id), nil, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return nil, fmt.Errorf("Could not resolve feedback batch (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var batch feedbackBatch
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return nil, err
	}
	if batch.Status != "claimed" {
		return nil, fmt.Errorf("Feedback batch %s is not claimed.", id)
	}
	return &batch, nil
}

func (c *client) feedbackClaim(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json", "idempotency-key"); err != nil || len(positional) != 1 {
		return fmt.Errorf(feedbackUsage)
	}
	key := operationKey(flags, "claim")
	return c.feedbackMutation("/api/feedback/"+url.PathEscape(positional[0])+"/claim", key, nil, flags["json"] == true, "Claimed")
}

func (c *client) feedbackComplete(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json", "version", "idempotency-key"); err != nil || len(positional) != 1 {
		return fmt.Errorf(feedbackUsage)
	}
	payload := struct {
		Version *int `json:"version,omitempty"`
	}{}
	if raw, ok := flags["version"].(string); ok {
		version, err := strconv.Atoi(raw)
		if err != nil || version < 0 {
			return fmt.Errorf("--version must be a non-negative integer")
		}
		payload.Version = &version
	}
	body, _ := json.Marshal(payload)
	key := operationKey(flags, "complete")
	return c.feedbackMutation("/api/feedback/"+url.PathEscape(positional[0])+"/complete", key, body, flags["json"] == true, "Completed")
}

func operationKey(flags map[string]any, prefix string) string {
	if key, ok := flags["idempotency-key"].(string); ok && strings.TrimSpace(key) != "" {
		return key
	}
	return prefix + "-" + strconv.FormatInt(timeNow().UnixNano(), 36)
}

var timeNow = func() time.Time { return time.Now() }

func (c *client) feedbackMutation(path, key string, body []byte, jsonOutput bool, verb string) error {
	headers := map[string]string{"Idempotency-Key": key}
	var reader *strings.Reader
	if body != nil {
		headers["Content-Type"] = "application/json"
		reader = strings.NewReader(string(body))
	} else {
		reader = strings.NewReader("")
	}
	resp, err := c.authed("POST", path, reader, headers)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Feedback operation failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var batch feedbackBatch
	if err := json.NewDecoder(resp.Body).Decode(&batch); err != nil {
		return err
	}
	if jsonOutput {
		return json.NewEncoder(c.out).Encode(batch)
	}
	fmt.Fprintf(c.out, "✓ %s feedback batch %s (%d comments)\n", verb, batch.ID, len(batch.Items))
	return nil
}
