package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"
)

type mcpAnnotations struct {
	ReadOnlyHint    bool `json:"readOnlyHint"`
	DestructiveHint bool `json:"destructiveHint"`
	IdempotentHint  bool `json:"idempotentHint"`
	OpenWorldHint   bool `json:"openWorldHint"`
}

type mcpTool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations mcpAnnotations  `json:"annotations"`
	call        func(c *client, args json.RawMessage, out *bytes.Buffer) (string, error)
}

const siteSchema = `{"type":"string","pattern":"^[^/]+/[^/]+$","description":"Site as <space>/<site>, e.g. team/report (from list or a deploy result)."}`

func findTool(name string) *mcpTool {
	for i := range mcpTools {
		if mcpTools[i].Name == name {
			return &mcpTools[i]
		}
	}
	return nil
}

// decodeArgs rejects unknown and mistyped arguments so the model gets an actionable error.
func decodeArgs(raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("Invalid arguments: %v", err)
	}
	return nil
}

func need(field, value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("Missing required argument: %s", field)
	}
	return nil
}

func withFlag(argv []string, name, value string) []string {
	if value == "" {
		return argv
	}
	return append(argv, "--"+name, value)
}

// runOutput runs one CLI command into the captured buffer and returns its trimmed output.
func runOutput(err error, out *bytes.Buffer) (string, error) {
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

// localPath requires an absolute path (or ~/...): the server's cwd is wherever the MCP client launched it.
func localPath(path string) (string, error) {
	if err := need("path", path); err != nil {
		return "", err
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		path = filepath.Join(home, strings.TrimPrefix(path, "~"))
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("path must be absolute, got %q", path)
	}
	return path, nil
}

var mcpTools = []mcpTool{
	{
		Name:  "deploy",
		Title: "Deploy to Postplan",
		Description: "Publish a local file or folder (HTML, markdown, images, PDFs, video, any static files) to Postplan and return its shareable URL. " +
			"A folder is served with index.html (or index.md) at its root; a single file is served at the site root. " +
			"Dotfiles, .git and node_modules are skipped. If the site name already exists you must pass replace: true to publish a new version; earlier versions stay restorable with rollback. " +
			"New sites default to unlisted visibility; a replace keeps the existing tier unless visibility is set.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"path":{"type":"string","description":"Absolute path (or ~/...) to the file or folder on this machine."},
"name":{"type":"string","description":"Site slug: lowercase, 3-40 chars. Defaults to the file or folder name."},
"space":{"type":"string","description":"Target space slug. Defaults to your personal space."},
"visibility":{"type":"string","enum":["unlisted","private","members","team"],"description":"unlisted: anyone with the URL, no login; private: you and explicit shares; members: people in the site's space; team: everyone in your org."},
"replace":{"type":"boolean","description":"Overwrite an existing site with this name as a new version. Required when the site exists."},
"notes":{"type":"string","description":"Change notes recorded on this version."},
"feedback_batch":{"type":"string","description":"ID of the claimed feedback batch this deploy addresses; targets that batch's site and version."}
},"required":["path"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Path          string `json:"path"`
				Name          string `json:"name"`
				Space         string `json:"space"`
				Visibility    string `json:"visibility"`
				Replace       bool   `json:"replace"`
				Notes         string `json:"notes"`
				FeedbackBatch string `json:"feedback_batch"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			path, err := localPath(a.Path)
			if err != nil {
				return "", err
			}
			argv := []string{"--json"}
			argv = withFlag(argv, "name", a.Name)
			argv = withFlag(argv, "space", a.Space)
			argv = withFlag(argv, "visibility", a.Visibility)
			argv = withFlag(argv, "notes", a.Notes)
			argv = withFlag(argv, "feedback-batch", a.FeedbackBatch)
			if a.Replace {
				argv = append(argv, "--yes")
			}
			return runOutput(c.deploy(append(argv, "--", path)), out)
		},
	},
	{
		Name:        "list",
		Title:       "List sites",
		Description: "List the Postplan sites you own or can edit, with each site's <space>/<site>, visibility and URL.",
		InputSchema: json.RawMessage(`{"type":"object","additionalProperties":false}`),
		Annotations: mcpAnnotations{ReadOnlyHint: true, IdempotentHint: true},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct{}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			return runOutput(c.list([]string{"--json"}), out)
		},
	},
	{
		Name:  "comments",
		Title: "Read review comments",
		Description: "Read a site's review comment threads as a markdown digest grouped by file. Each thread heading ends with its thread ID, which reply needs. " +
			"Open comments are context, not a work queue: act on feedback batches (see the feedback tool) unless the user asks otherwise.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"site":` + siteSchema + `,
"file":{"type":"string","description":"Only threads on this in-site file path, e.g. index.html."},
"open_only":{"type":"boolean","description":"Hide resolved threads."}
},"required":["site"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{ReadOnlyHint: true, IdempotentHint: true},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site     string `json:"site"`
				File     string `json:"file"`
				OpenOnly bool   `json:"open_only"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			if err := need("site", a.Site); err != nil {
				return "", err
			}
			argv := withFlag(nil, "file", a.File)
			if a.OpenOnly {
				argv = append(argv, "--open")
			}
			return runOutput(c.comments(append(argv, "--", a.Site)), out)
		},
	},
	{
		Name:  "read",
		Title: "Read a deployed file",
		Description: "Return the text of one file in a deployed site, e.g. to check what is live before editing. Omit file for the site root. " +
			"Markdown files come back as rendered HTML. Output over 200 KB is truncated; binary files return an error.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"site":` + siteSchema + `,
"file":{"type":"string","description":"In-site file path, e.g. index.html or docs/guide.md. Omit for the site root."}
},"required":["site"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{ReadOnlyHint: true, IdempotentHint: true},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site string `json:"site"`
				File string `json:"file"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			if err := need("site", a.Site); err != nil {
				return "", err
			}
			if err := c.read(append(withFlag(nil, "file", a.File), "--", a.Site)); err != nil {
				return "", err
			}
			return capText(out.Bytes(), mcpReadLimit)
		},
	},
	{
		Name:  "reply",
		Title: "Reply to a thread",
		Description: "Post a reply on a review comment thread, e.g. to say what you changed. The reply is prefixed with [agent] unless tag is set. " +
			"Get thread IDs from the comments tool or a feedback batch's items.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"site":` + siteSchema + `,
"thread_id":{"type":"string","description":"Thread ID to reply to."},
"message":{"type":"string","description":"Reply body (markdown)."},
"tag":{"type":"string","description":"Attribution label shown as [tag], e.g. claude. Defaults to agent."}
},"required":["site","thread_id","message"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site     string `json:"site"`
				ThreadID string `json:"thread_id"`
				Message  string `json:"message"`
				Tag      string `json:"tag"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			for _, f := range [][2]string{{"site", a.Site}, {"thread_id", a.ThreadID}, {"message", a.Message}} {
				if err := need(f[0], f[1]); err != nil {
					return "", err
				}
			}
			argv := withFlag(nil, "tag", a.Tag)
			return runOutput(c.reply(append(argv, "--", a.Site, a.ThreadID, a.Message)), out)
		},
	},
	{
		Name:  "feedback",
		Title: "Feedback batches",
		Description: "Work the review queue. Reviewers send comments as feedback batches; these are the only comments an agent should act on automatically. " +
			"Actions: list (pending batches, optionally for one site); wait (claim the next batch, polling up to timeout_seconds, max 50; returns a 'no feedback' message on timeout, so call again to keep waiting); " +
			"claim (claim batch_id); complete (mark batch_id done, passing the version you deployed). " +
			"Loop: claim, edit, deploy with replace: true and feedback_batch, reply to threads, then complete.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"action":{"type":"string","enum":["list","wait","claim","complete"]},
"site":` + siteSchema + `,
"batch_id":{"type":"string","description":"Batch ID. Required for claim and complete."},
"version":{"type":"integer","minimum":0,"description":"For complete: the site version that addresses the batch."},
"timeout_seconds":{"type":"integer","minimum":1,"maximum":50,"default":20,"description":"For wait: how long to poll before returning."}
},"required":["action"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Action  string `json:"action"`
				Site    string `json:"site"`
				BatchID string `json:"batch_id"`
				Version *int   `json:"version"`
				Timeout *int   `json:"timeout_seconds"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			switch a.Action {
			case "list":
				return runOutput(c.feedback(siteArgs([]string{"list", "--json"}, a.Site)), out)
			case "wait":
				timeout := 20
				if a.Timeout != nil {
					timeout = *a.Timeout
				}
				if timeout < 1 || timeout > 50 {
					return "", fmt.Errorf("timeout_seconds must be between 1 and 50")
				}
				text, err := runOutput(c.feedback(siteArgs([]string{"wait", "--json", "--timeout", strconv.Itoa(timeout) + "s"}, a.Site)), out)
				if err == nil && text == "null" {
					text = fmt.Sprintf("No feedback received within %ds. Call wait again to keep listening.", timeout)
				}
				return text, err
			case "claim", "complete":
				if err := need("batch_id", a.BatchID); err != nil {
					return "", err
				}
				argv := []string{a.Action, "--json"}
				if a.Action == "complete" && a.Version != nil {
					argv = append(argv, "--version", strconv.Itoa(*a.Version))
				}
				return runOutput(c.feedback(append(argv, "--", a.BatchID)), out)
			default:
				return "", fmt.Errorf("action must be one of list, wait, claim, complete")
			}
		},
	},
	{
		Name:        "versions",
		Title:       "Version history",
		Description: "List a site's deployment history: version numbers, which is current, timestamps, change notes and files. Use with rollback.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"site":` + siteSchema + `},"required":["site"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{ReadOnlyHint: true, IdempotentHint: true},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site string `json:"site"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			if err := need("site", a.Site); err != nil {
				return "", err
			}
			return runOutput(c.versions([]string{"--json", "--", a.Site}), out)
		},
	},
	{
		Name:        "rollback",
		Title:       "Restore a version",
		Description: "Restore an earlier version of a site. This publishes it as a new current version, so history is never lost. Returns the new version and URL.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"site":` + siteSchema + `,
"version":{"type":"integer","minimum":0,"description":"Version number to restore (see versions)."},
"notes":{"type":"string","description":"Change notes recorded on the new version."}
},"required":["site","version"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site    string `json:"site"`
				Version *int   `json:"version"`
				Notes   string `json:"notes"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			if err := need("site", a.Site); err != nil {
				return "", err
			}
			if a.Version == nil {
				return "", fmt.Errorf("Missing required argument: version")
			}
			argv := withFlag([]string{"--yes", "--json"}, "notes", a.Notes)
			return runOutput(c.rollback(append(argv, "--", a.Site, strconv.Itoa(*a.Version))), out)
		},
	},
	{
		Name:        "delete",
		Title:       "Delete a site",
		Description: "Permanently delete a site, its versions and its comments. This cannot be undone; confirm with the user first.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{"site":` + siteSchema + `},"required":["site"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{DestructiveHint: true, IdempotentHint: true},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site string `json:"site"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			if err := need("site", a.Site); err != nil {
				return "", err
			}
			text, err := runOutput(c.del([]string{"--yes", "--", a.Site}), out)
			if err == nil {
				text = "✓ Deleted " + a.Site + "."
			}
			return text, err
		},
	},
	{
		Name:        "fork",
		Title:       "Fork a site",
		Description: "Copy a site you can read into a space you can edit, e.g. to make your own draft of someone else's page. Returns the new site's URL.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{
"site":` + siteSchema + `,
"space":{"type":"string","description":"Destination space slug. Defaults to your personal space."},
"name":{"type":"string","description":"New site slug: lowercase, 3-40 chars. Defaults to <site>-copy."}
},"required":["site"],"additionalProperties":false}`),
		Annotations: mcpAnnotations{},
		call: func(c *client, raw json.RawMessage, out *bytes.Buffer) (string, error) {
			var a struct {
				Site  string `json:"site"`
				Space string `json:"space"`
				Name  string `json:"name"`
			}
			if err := decodeArgs(raw, &a); err != nil {
				return "", err
			}
			if err := need("site", a.Site); err != nil {
				return "", err
			}
			argv := withFlag(nil, "space", a.Space)
			argv = withFlag(argv, "name", a.Name)
			return runOutput(c.fork(append(argv, "--", a.Site)), out)
		},
	},
}

const mcpReadLimit = 200 * 1024

// capText returns body as text, cut at a rune boundary under limit with a note; binary bodies are refused.
func capText(body []byte, limit int) (string, error) {
	total := len(body)
	if total > limit {
		body = body[:limit]
		for i := 0; i < utf8.UTFMax-1 && len(body) > 0; i++ {
			if r, _ := utf8.DecodeLastRune(body); r != utf8.RuneError {
				break
			}
			body = body[:len(body)-1]
		}
	}
	if !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
		return "", fmt.Errorf("This file is binary (%d bytes); open it in a browser instead.", total)
	}
	if total > limit {
		return fmt.Sprintf("%s\n\n[truncated: showing %d of %d bytes]", body, len(body), total), nil
	}
	return string(body), nil
}

func siteArgs(argv []string, site string) []string {
	if site == "" {
		return argv
	}
	return append(argv, "--", site)
}
