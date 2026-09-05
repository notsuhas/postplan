package cli

import (
	"fmt"
	"io"
	"net/url"
	"postplan/internal/argparse"
	"postplan/internal/digest"
)

func (c *client) comments(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"open": true, "json": true})
	target := ""
	if len(positional) > 0 {
		target = positional[0]
	}
	space, name, err := splitSpaceSlug(target)
	if err != nil {
		return fmt.Errorf("Usage: postplan comments <space/slug> [--file <path>] [--open] [--json]")
	}
	if err := c.requireAuth(); err != nil {
		return err
	}

	query := ""
	if file, isStr := flags["file"].(string); isStr && file != "" {
		query = "?filePath=" + url.PathEscape(file)
	}
	resp, err := c.authed("GET", "/api/sites/"+space+"/"+name+"/comments"+query, nil, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Failed to fetch comments (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	threads, err := digest.ParseThreads(data)
	if err != nil {
		return err
	}
	digest, err := digest.Render(threads, flags["open"] == true, flags["json"] == true)
	if err != nil {
		return err
	}
	fmt.Fprintln(c.out, digest)
	return nil
}
