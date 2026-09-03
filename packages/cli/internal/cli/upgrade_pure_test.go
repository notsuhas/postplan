package cli

import (
	"glance/internal/selfupdate"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	if selfupdate.CompareVersions("0.5.0", "0.4.9") <= 0 {
		t.Error("0.5.0 should be > 0.4.9")
	}
	if selfupdate.CompareVersions("0.4.0", "0.4.0") != 0 {
		t.Error("equal versions should compare 0")
	}
	if selfupdate.CompareVersions("0.4", "0.4.1") >= 0 {
		t.Error("0.4 should be < 0.4.1 (missing parts count as 0)")
	}
	if selfupdate.CompareVersions("1.0.0", "0.99.99") <= 0 {
		t.Error("1.0.0 should be > 0.99.99 (numeric, not lexicographic)")
	}
	// a non-CLI release tag must never look like an upgrade target
	if selfupdate.CompareVersions("ui-screens", "0.0.0") != 0 {
		t.Error("ui-screens vs 0.0.0 should be 0")
	}
	if selfupdate.CompareVersions("ui-screens", "0.4.0") >= 0 {
		t.Error("ui-screens should never compare newer than 0.4.0")
	}
}

func TestParseLatestTag(t *testing.T) {
	cases := map[string]string{
		"https://github.com/plivo-labs/glance/releases/tag/v0.4.0":        "v0.4.0",
		"http://127.0.0.1:8080/releases/tag/v9.9.9?x=1#top":               "v9.9.9",
		"https://github.com/plivo-labs/glance/releases/tag/v0.4.0-rc%2B1": "v0.4.0-rc+1",
	}
	for url, want := range cases {
		if got := selfupdate.ParseLatestTag(url); got != want {
			t.Errorf("selfupdate.ParseLatestTag(%q) = %q, want %q", url, got, want)
		}
	}
	for _, url := range []string{
		"https://github.com/plivo-labs/glance/releases/latest",
		"https://github.com/plivo-labs/glance/releases/tag/",
	} {
		if got := selfupdate.ParseLatestTag(url); got != "" {
			t.Errorf("selfupdate.ParseLatestTag(%q) = %q, want empty", url, got)
		}
	}
}

func TestAssetName(t *testing.T) {
	if got := selfupdate.AssetName("darwin", "arm64"); got != "glance-arm64-darwin" {
		t.Errorf("darwin/arm64 = %q", got)
	}
	if got := selfupdate.AssetName("linux", "x64"); got != "glance-x64-linux" {
		t.Errorf("linux/x64 = %q", got)
	}
	if got := selfupdate.AssetName("win32", "x64"); got != "" {
		t.Errorf("win32/x64 = %q, want empty", got)
	}
	if got := selfupdate.AssetName("linux", "ia32"); got != "" {
		t.Errorf("linux/ia32 = %q, want empty", got)
	}
}

func TestShouldCheck(t *testing.T) {
	const day = int64(24 * 60 * 60 * 1000)
	if !selfupdate.ShouldCheck(selfupdate.UpdateState{}, 1000) {
		t.Error("never-checked should return true")
	}
	if selfupdate.ShouldCheck(selfupdate.UpdateState{LastCheckedAt: 1000}, 1000+day-1) {
		t.Error("within window should return false")
	}
	if !selfupdate.ShouldCheck(selfupdate.UpdateState{LastCheckedAt: 1000}, 1000+day+1) {
		t.Error("expired window should return true")
	}
}

func TestPlanAnnouncement(t *testing.T) {
	t.Run("after-swap-announces-once", func(t *testing.T) {
		st := selfupdate.UpdateState{LastCheckedAt: 1, UpdatedTo: "0.5.0"}
		msg, next, changed := selfupdate.PlanAnnouncement(st, "0.5.0")
		if !strings.Contains(msg, "0.5.0") || !changed {
			t.Fatalf("msg=%q changed=%v", msg, changed)
		}
		if next.UpdatedTo != "" {
			t.Errorf("updatedTo not cleared: %q", next.UpdatedTo)
		}
		if next.LastCheckedAt != 1 {
			t.Errorf("unrelated state lost: %d", next.LastCheckedAt)
		}
		// cleared state announces nothing next run
		if msg2, _, _ := selfupdate.PlanAnnouncement(next, "0.5.0"); msg2 != "" {
			t.Errorf("re-announced: %q", msg2)
		}
	})

	t.Run("stale-swap-clears-silently", func(t *testing.T) {
		// a manual reinstall raced the background swap - never claim a version we're not running
		msg, next, changed := selfupdate.PlanAnnouncement(selfupdate.UpdateState{UpdatedTo: "0.5.0"}, "0.6.0")
		if msg != "" || !changed || next.UpdatedTo != "" {
			t.Fatalf("msg=%q changed=%v next=%+v", msg, changed, next)
		}
	})

	t.Run("noop-reports-unchanged", func(t *testing.T) {
		// callers skip the state write when nothing changed
		st := selfupdate.UpdateState{LastCheckedAt: 1}
		_, next, changed := selfupdate.PlanAnnouncement(st, "0.4.0")
		if changed || next != st {
			t.Errorf("changed=%v next=%+v", changed, next)
		}
	})
}
