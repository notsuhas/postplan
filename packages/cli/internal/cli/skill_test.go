package cli

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSkillEmbed(t *testing.T) {
	if skillName != "postplan-cli" {
		t.Errorf("skillName = %q", skillName)
	}
	if !strings.Contains(skillMD, "### reply") || !strings.Contains(skillMD, "postplan reply <space/slug> <threadId>") {
		t.Error("embedded skill missing reply docs")
	}
}

func TestSkillInstall(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	c, out := newTestClient("http://unused", "")
	if err := c.skillCmd(nil); err != nil { // default subcommand is "install"
		t.Fatalf("skillCmd: %v", err)
	}
	dest := filepath.Join(os.Getenv("HOME"), ".claude", "skills", "postplan-cli", "SKILL.md")
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("skill not installed: %v", err)
	}
	if string(got) != skillMD {
		t.Error("installed SKILL.md != embedded content")
	}
	if !strings.Contains(out.String(), "Installed") {
		t.Fatalf("out = %q", out.String())
	}
}
