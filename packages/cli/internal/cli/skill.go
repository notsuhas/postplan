package cli

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"postplan/internal/argparse"
	"sort"
)

//go:embed SKILL.md
var skillMD string

const skillName = "postplan-cli"

var skillTargetPaths = map[string][]string{
	"agents":   {".agents", "skills"},
	"claude":   {".claude", "skills"},
	"codex":    {".codex", "skills"},
	"cursor":   {".cursor", "skills"},
	"opencode": {".config", "opencode", "skills"},
}

func (c *client) skillCmd(argv []string) error {
	sub := "install"
	if len(argv) > 0 && argv[0] != "--target" && argv[0] != "--dry-run" {
		sub = argv[0]
		argv = argv[1:]
	}
	if sub != "install" {
		return fmt.Errorf("Usage: postplan skill install [--target auto|all|agents|claude|codex|cursor|opencode] [--dry-run]")
	}
	positional, flags := argparse.ParseArgs(argv, map[string]bool{"dry-run": true})
	if err := argparse.ValidateFlags(flags, "target", "dry-run"); err != nil {
		return err
	}
	if len(positional) != 0 {
		return fmt.Errorf("Usage: postplan skill install [--target <name>] [--dry-run]")
	}
	target := "auto"
	if raw, ok := flags["target"]; ok {
		target = raw.(string)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	dirs, err := resolveSkillTargets(home, target)
	if err != nil {
		return err
	}
	for _, dir := range dirs {
		dest := filepath.Join(dir, skillName, "SKILL.md")
		if flags["dry-run"] == true {
			fmt.Fprintf(c.out, "Would install %s → %s\n", skillName, dest)
			continue
		}
		if err := writeSkill(dest); err != nil {
			return err
		}
		fmt.Fprintf(c.out, "✓ Installed %s → %s\n", skillName, dest)
	}
	return nil
}

func resolveSkillTargets(home, target string) ([]string, error) {
	names := []string{"agents", "claude", "codex", "cursor", "opencode"}
	if target != "auto" && target != "all" {
		if _, ok := skillTargetPaths[target]; !ok {
			return nil, fmt.Errorf("Unknown skill target %q", target)
		}
		names = []string{target}
	}
	var dirs []string
	seen := map[string]bool{}
	for _, name := range names {
		dir := filepath.Join(append([]string{home}, skillTargetPaths[name]...)...)
		if target == "auto" {
			if _, err := os.Stat(dir); err != nil {
				continue
			}
		}
		key := canonicalPath(dir)
		if !seen[key] {
			seen[key] = true
			dirs = append(dirs, dir)
		}
	}
	if len(dirs) == 0 {
		dirs = []string{filepath.Join(home, ".agents", "skills")}
	}
	sort.Strings(dirs)
	return dirs, nil
}

func canonicalPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return resolved
	}
	return filepath.Clean(path)
}

func writeSkill(dest string) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".SKILL.md-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(skillMD); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, dest)
}
