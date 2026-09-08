package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"postplan/internal/argparse"
)

type shareGrant struct {
	ID   string `json:"id"`
	Role string `json:"role"`
}

type shareSet struct {
	Users    []shareGrant `json:"users"`
	GroupIDs []string     `json:"groupIds"`
}

const sharesUsage = "Usage: postplan shares list <space/site> [--json] | grant <space/site> <user-id> [--role viewer|editor] [--json] | revoke <space/site> <user-id> [--json]"

func (c *client) shares(argv []string) error {
	if len(argv) == 0 {
		return fmt.Errorf(sharesUsage)
	}
	switch argv[0] {
	case "list":
		return c.sharesList(argv[1:])
	case "grant", "revoke":
		return c.sharesChange(argv[0], argv[1:])
	default:
		return fmt.Errorf(sharesUsage)
	}
}

func (c *client) readShares(space, site string) (shareSet, error) {
	resp, err := c.authed("GET", "/api/sites/"+space+"/"+site+"/shares", nil, nil)
	if err != nil {
		return shareSet{}, err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return shareSet{}, fmt.Errorf("Could not read shares (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var shares shareSet
	err = json.NewDecoder(resp.Body).Decode(&shares)
	return shares, err
}

func (c *client) sharesList(argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json"); err != nil || len(positional) != 1 {
		return fmt.Errorf(sharesUsage)
	}
	space, site, err := splitSpaceSlug(positional[0])
	if err != nil {
		return fmt.Errorf(sharesUsage)
	}
	shares, err := c.readShares(space, site)
	if err != nil {
		return err
	}
	if flags["json"] == true {
		return json.NewEncoder(c.out).Encode(shares)
	}
	for _, user := range shares.Users {
		fmt.Fprintf(c.out, "%s  %s\n", user.ID, user.Role)
	}
	for _, group := range shares.GroupIDs {
		fmt.Fprintf(c.out, "%s  group\n", group)
	}
	return nil
}

func (c *client) sharesChange(action string, argv []string) error {
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"json": true})
	if err := argparse.ValidateFlags(flags, "json", "role"); err != nil || len(positional) != 2 {
		return fmt.Errorf(sharesUsage)
	}
	space, site, err := splitSpaceSlug(positional[0])
	if err != nil {
		return fmt.Errorf(sharesUsage)
	}
	role := "viewer"
	if raw, ok := flags["role"].(string); ok {
		role = raw
	}
	if role != "viewer" && role != "editor" {
		return fmt.Errorf("--role must be viewer or editor")
	}
	shares, err := c.readShares(space, site)
	if err != nil {
		return err
	}
	next := make([]shareGrant, 0, len(shares.Users)+1)
	for _, grant := range shares.Users {
		if grant.ID != positional[1] {
			next = append(next, grant)
		}
	}
	if action == "grant" {
		next = append(next, shareGrant{ID: positional[1], Role: role})
	}
	shares.Users = next
	body, _ := json.Marshal(shares)
	resp, err := c.authed("PUT", "/api/sites/"+space+"/"+site+"/shares", bytes.NewReader(body), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		return fmt.Errorf("Could not update shares (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	if flags["json"] == true {
		var result any
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return err
		}
		return json.NewEncoder(c.out).Encode(result)
	}
	verb := "Granted"
	if action == "revoke" {
		verb = "Revoked"
	}
	fmt.Fprintf(c.out, "✓ %s %s on %s/%s\n", verb, positional[1], space, site)
	return nil
}
