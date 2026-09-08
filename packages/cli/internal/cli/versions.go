package cli

import (
	"encoding/json"
	"fmt"
	"postplan/internal/argparse"
	"strconv"
	"strings"
)

type versionFile struct {
	Path string `json:"path"`
}

type siteVersion struct {
	Version         int           `json:"version"`
	CreatedAt       string        `json:"createdAt"`
	RestoredFrom    *int          `json:"restoredFrom"`
	Current         bool          `json:"current"`
	Files           []versionFile `json:"files"`
	ChangeNotes     *string       `json:"changeNotes"`
	FeedbackBatchID *string       `json:"feedbackBatchId"`
}

func (c *client) versions(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json"); err != nil {
		return err
	}
	if len(positional) != 1 {
		return fmt.Errorf("Usage: postplan versions <space/site> [--json]")
	}
	space, site, err := splitSpaceSlug(positional[0])
	if err != nil {
		return fmt.Errorf("Usage: postplan versions <space/site> [--json]")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	resp, err := c.authed("GET", "/api/sites/"+space+"/"+site+"/versions", nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Could not list versions (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var rows []siteVersion
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return err
	}
	if flags["json"] == true {
		return json.NewEncoder(c.out).Encode(rows)
	}
	for _, row := range rows {
		label := fmt.Sprintf("v%d", row.Version)
		if row.Current {
			label += " (current)"
		}
		if row.RestoredFrom != nil {
			label += fmt.Sprintf(" ← v%d", *row.RestoredFrom)
		}
		fmt.Fprintf(c.out, "%-18s %3d files  %s\n", label, len(row.Files), row.CreatedAt)
		if row.ChangeNotes != nil {
			fmt.Fprintf(c.out, "  %s\n", *row.ChangeNotes)
		}
		for _, file := range row.Files {
			fmt.Fprintf(c.out, "    %s\n", file.Path)
		}
	}
	return nil
}

func (c *client) rollback(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"yes": true, "json": true})
	if err := argparse.ValidateFlags(flags, "yes", "json", "notes", "feedback-batch", "idempotency-key"); err != nil {
		return err
	}
	if len(positional) != 2 {
		return fmt.Errorf("Usage: postplan rollback <space/site> <version> [--yes] [--json]")
	}
	space, site, err := splitSpaceSlug(positional[0])
	version, versionErr := strconv.Atoi(positional[1])
	if err != nil || versionErr != nil || version < 0 {
		return fmt.Errorf("Usage: postplan rollback <space/site> <version> [--yes] [--json]")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}
	current, err := c.currentVersion(space, site)
	if err != nil {
		return err
	}
	if flags["yes"] != true {
		answer := c.prompt(fmt.Sprintf("Restore %s/%s from v%d as v%d? (y/N) ", space, site, version, current+1))
		if strings.ToLower(answer) != "y" {
			fmt.Fprintln(c.out, "Cancelled.")
			return nil
		}
	}
	payloadBody := map[string]any{"expectedVersion": current}
	if notes, ok := flags["notes"].(string); ok && strings.TrimSpace(notes) != "" {
		payloadBody["changeNotes"] = strings.TrimSpace(notes)
	}
	if batch, ok := flags["feedback-batch"].(string); ok && strings.TrimSpace(batch) != "" {
		payloadBody["feedbackBatchId"] = strings.TrimSpace(batch)
	}
	payload, _ := json.Marshal(payloadBody)
	resp, err := c.authed("POST", fmt.Sprintf("/api/sites/%s/%s/versions/%d/rollback", space, site, version), strings.NewReader(string(payload)), map[string]string{
		"Content-Type":    "application/json",
		"Idempotency-Key": operationKey(flags, "rollback"),
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Rollback failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}
	if flags["json"] == true {
		return json.NewEncoder(c.out).Encode(result)
	}
	fmt.Fprintf(c.out, "✓ Restored v%d as v%.0f → %s\n", version, result["version"], result["url"])
	return nil
}

func (c *client) currentVersion(space, site string) (int, error) {
	resp, err := c.authed("GET", "/api/sites/"+space+"/"+site+"/versions", nil, nil)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return 0, fmt.Errorf("Could not read versions (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var rows []siteVersion
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return 0, err
	}
	for _, row := range rows {
		if row.Current {
			return row.Version, nil
		}
	}
	return 0, fmt.Errorf("Current version not found")
}
