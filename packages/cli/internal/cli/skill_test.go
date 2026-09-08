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
	dest := filepath.Join(os.Getenv("HOME"), ".agents", "skills", "postplan-cli", "SKILL.md")
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

func TestSkillInstallTargets(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.MkdirAll(filepath.Join(home, ".codex", "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	c, _ := newTestClient("http://unused", "")
	if err := c.skillCmd([]string{"install", "--target", "auto"}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(home, ".codex", "skills", skillName, "SKILL.md")
	if _, err := os.Stat(dest); err != nil {
		t.Fatalf("Codex target not installed: %v", err)
	}
}

func TestSkillInstallDryRun(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	c, out := newTestClient("http://unused", "")
	if err := c.skillCmd([]string{"install", "--target", "cursor", "--dry-run"}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Would install") {
		t.Fatalf("out = %q", out.String())
	}
}
