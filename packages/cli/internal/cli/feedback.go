package cli

import (
	"encoding/json"
	"fmt"
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

const feedbackUsage = "Usage: postplan feedback list [space/site] [--json] | claim <batch-id> [--idempotency-key <key>] [--json] | complete <batch-id> [--version <n>] [--idempotency-key <key>] [--json]"

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
	path := "/api/feedback"
	if len(positional) == 1 {
		if _, _, err := splitSpaceSlug(positional[0]); err != nil {
			return fmt.Errorf(feedbackUsage)
		}
		path += "?site=" + url.QueryEscape(positional[0])
	}
	resp, err := c.authed("GET", path, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Could not list feedback (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var batches []feedbackBatch
	if err := json.NewDecoder(resp.Body).Decode(&batches); err != nil {
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
