package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime/multipart"
	"os"
	"path/filepath"
	"postplan/internal/argparse"
	"postplan/internal/slug"
	"strconv"
	"strings"
)

type deployEntry struct {
	abs string
	rel string // POSIX in-site path
}

// walk lists regular files under dir recursively. It always skips VCS/build noise (.git,
// node_modules, .DS_Store) and NEVER follows symlinks - a symlink could point outside the deploy
// root (e.g. /etc/passwd or ~/.ssh) and leak its target. Unless includeHidden is set it also skips
// dotfiles/dot-dirs (.env, .npmrc, .netrc, …) so secrets aren't uploaded by accident.
func walk(dir string, includeHidden bool) ([]string, error) {
	var out []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path == dir {
			return nil
		}
		name := d.Name()
		// .postplan holds the pull.json round-trip marker — internal bookkeeping, never site content.
		skip := name == ".git" || name == "node_modules" || name == ".DS_Store" || name == pullMarkerDir ||
			(!includeHidden && strings.HasPrefix(name, "."))
		if skip {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 {
			return nil // don't follow symlinks (target may escape the deploy root)
		}
		if !d.IsDir() {
			out = append(out, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// personalSpace resolves the caller's personal space - the default target when --space is omitted.
func (c *client) personalSpace() (string, error) {
	resp, err := c.authed("GET", "/api/spaces/mine", nil, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return "", fmt.Errorf("Could not resolve your space (%d). Pass --space <slug>.", resp.StatusCode)
	}
	var spaces []struct {
		Slug string `json:"slug"`
		Type string `json:"type"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&spaces); err != nil {
		return "", err
	}
	if len(spaces) == 0 {
		return "", fmt.Errorf("No space found for your account. Pass --space <slug>.")
	}
	for _, s := range spaces {
		if s.Type == "personal" {
			return s.Slug, nil
		}
	}
	return spaces[0].Slug, nil
}

func (c *client) deploy(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"include-hidden": true, "yes": true, "json": true})
	if err := argparse.ValidateFlags(flags, "include-hidden", "yes", "json", "visibility", "space", "name", "notes", "feedback-batch", "idempotency-key"); err != nil {
		return err
	}
	if len(positional) > 1 {
		return fmt.Errorf("Expected one path, got %d", len(positional))
	}
	path := ""
	if len(positional) > 0 {
		path = positional[0]
	}
	includeHidden := flags["include-hidden"] == true
	assumeYes := flags["yes"] == true
	jsonOutput := flags["json"] == true

	visibility := "team"
	visibilitySet := false
	if raw, present := flags["visibility"]; present {
		visibility = raw.(string)
		visibilitySet = true
	}
	if visibility != "unlisted" && visibility != "private" && visibility != "members" && visibility != "team" {
		return fmt.Errorf("Invalid visibility %q. Use unlisted, private, members, or team.", visibility)
	}
	if path == "" {
		return fmt.Errorf("Usage: postplan deploy <path> [--space <slug>] [--name <slug>] [--visibility unlisted|private|members|team] [--include-hidden]")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}

	root, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	info, err := os.Stat(root)
	if err != nil {
		return fmt.Errorf("No such file or directory: %s", root)
	}

	// A tree produced by `read --pull` carries a .postplan/pull.json marker: redeploy it to the SAME
	// site, pass the pulled contentVersion as the CAS token (editor replaces require it), and
	// re-include dotfiles (they were pulled, so they're part of the source). The .postplan/ dir itself
	// is excluded from the walk above.
	var marker *pullMarker
	if info.IsDir() {
		if m, ok := readPullMarker(root); ok {
			marker = m
			includeHidden = true
		}
	}

	feedbackBatchID := ""
	var targetBatch *feedbackBatch
	if raw, ok := flags["feedback-batch"].(string); ok {
		feedbackBatchID = strings.TrimSpace(raw)
	}
	if feedbackBatchID != "" {
		targetBatch, err = c.feedbackBatchByID(feedbackBatchID)
		if err != nil {
			return err
		}
	}

	// Accept a single file OR a folder. A lone file uploads under its own name and is served at
	// the site root (the content worker falls back to the only file).
	var entries []deployEntry
	var derived string
	if info.IsDir() {
		files, err := walk(root, includeHidden)
		if err != nil {
			return err
		}
		for _, abs := range files {
			rel, _ := filepath.Rel(root, abs)
			entries = append(entries, deployEntry{abs: abs, rel: filepath.ToSlash(rel)})
		}
		// Not filepath.Base: a build-output leaf like ./dist would name every site "dist".
		derived = slug.NameFromDir(root)
	} else {
		base := filepath.Base(root)
		entries = []deployEntry{{abs: root, rel: base}}
		derived = strings.TrimSuffix(base, filepath.Ext(base)) // default name = file name, sans extension
	}
	if len(entries) == 0 {
		return fmt.Errorf("No files to upload.")
	}

	// Name/space default from the pull marker (redeploy targets the same site) before falling back to
	// the derived name / the caller's personal space — an editor's personal space is NOT where the
	// owner's site lives, so a pulled redeploy must reuse the recorded target.
	name := ""
	if raw, present := flags["name"]; present {
		name = raw.(string)
		if targetBatch != nil && name != targetBatch.Site.Slug {
			return fmt.Errorf("Feedback batch %s belongs to %s/%s; refusing conflicting --name %s.", feedbackBatchID, targetBatch.Site.Space, targetBatch.Site.Slug, name)
		}
	} else if targetBatch != nil {
		name = targetBatch.Site.Slug
	} else if marker != nil {
		name = marker.Name
	} else {
		name = slug.Slugify(derived)
	}
	if !slug.IsValidSlug(name) {
		return fmt.Errorf("Couldn't derive a valid name from %q. Pass --name <slug> (lowercase, 3–40 chars).", filepath.Base(root))
	}

	space := ""
	if raw, present := flags["space"]; present {
		space = raw.(string)
		if targetBatch != nil && space != targetBatch.Site.Space {
			return fmt.Errorf("Feedback batch %s belongs to %s/%s; refusing conflicting --space %s.", feedbackBatchID, targetBatch.Site.Space, targetBatch.Site.Slug, space)
		}
	} else if targetBatch != nil {
		space = targetBatch.Site.Space
	} else if marker != nil {
		space = marker.Space
	} else {
		s, err := c.personalSpace()
		if err != nil {
			return err
		}
		space = s
	}

	// Replace prompt if the site already exists and the caller owns it. Don't treat a failed check
	// as "does not exist": a non-2xx status or an undecodable body must abort, not silently upload
	// (which could clobber a site or race an unexpected server state).
	exResp, err := c.authed("GET", "/api/sites/"+space+"/"+name+"/exists", nil, nil)
	if err != nil {
		return err
	}
	if !ok(exResp) {
		code := exResp.StatusCode
		exResp.Body.Close()
		return fmt.Errorf("Could not check whether %s/%s already exists (%d).", space, name, code)
	}
	var ex struct {
		Exists     bool `json:"exists"`
		CanReplace bool `json:"canReplace"`
	}
	decErr := json.NewDecoder(exResp.Body).Decode(&ex)
	exResp.Body.Close()
	if decErr != nil {
		return fmt.Errorf("Could not read the existence check for %s/%s: %w", space, name, decErr)
	}
	replace := false
	if ex.Exists {
		if !ex.CanReplace {
			return fmt.Errorf("%s/%s is taken by another user.", space, name)
		}
		if !assumeYes {
			ans := c.prompt(fmt.Sprintf("Site exists at %s/%s. Replace? (y/N) ", space, name))
			if strings.ToLower(ans) != "y" {
				fmt.Fprintln(c.out, "Cancelled.")
				return nil
			}
		}
		replace = true
	}

	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	// Send visibility on create, but on replace only when --visibility was explicitly passed. The
	// default is "team", so unconditionally sending it would silently re-tier an existing (e.g.
	// private) site to team on a routine content update. Absent on replace → server keeps the tier.
	if visibilitySet || !replace {
		_ = mw.WriteField("visibility", visibility)
	}
	// Pulled redeploy: send the version we pulled as the CAS token. The server REQUIRES it for an
	// editor replace (409 on a stale one) and treats it as advisory for an owner.
	if replace && targetBatch != nil {
		_ = mw.WriteField("expectedVersion", strconv.Itoa(targetBatch.SiteVersion))
	} else if replace && marker != nil {
		_ = mw.WriteField("expectedVersion", strconv.Itoa(marker.ContentVersion))
	}
	if notes, ok := flags["notes"].(string); ok && strings.TrimSpace(notes) != "" {
		_ = mw.WriteField("changeNotes", strings.TrimSpace(notes))
	}
	if feedbackBatchID != "" {
		_ = mw.WriteField("feedbackBatchId", feedbackBatchID)
	}
	for _, e := range entries {
		data, err := os.ReadFile(e.abs)
		if err != nil {
			return err
		}
		fw, err := mw.CreateFormFile("files", e.rel)
		if err != nil {
			return err
		}
		if _, err := fw.Write(data); err != nil {
			return err
		}
	}
	if err := mw.Close(); err != nil {
		return err
	}

	if !jsonOutput {
		fmt.Fprintf(c.out, "Uploading %d file(s) to %s/%s…\n", len(entries), space, name)
		for _, e := range entries {
			fmt.Fprintf(c.out, "  %s\n", e.rel)
		}
	}
	uploadPath := "/api/upload/" + space + "/" + name
	if replace {
		uploadPath += "?replace=true"
	}
	resp, err := c.authed("POST", uploadPath, &body, map[string]string{
		"Content-Type":    mw.FormDataContentType(),
		"Idempotency-Key": operationKey(flags, "publish"),
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Upload failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var result struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}
	if jsonOutput {
		return json.NewEncoder(c.out).Encode(map[string]any{
			"url": result.URL, "space": space, "site": name, "files": len(entries), "replaced": replace,
		})
	}
	fmt.Fprintf(c.out, "✓ Deployed → %s\n", result.URL)
	return nil
}
