package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func dataServer(t *testing.T, caps string, putStatus int) (func() []capturedReq, string) {
	srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
		if strings.HasPrefix(r.path, "/api/data-token/") {
			return 200, `{"token":"data-tok","caps":` + caps + `,"expiresIn":300}`
		}
		return putStatus, `{}`
	})
	return func() []capturedReq { return *reqs }, srv.URL
}

func TestDataPush(t *testing.T) {
	t.Run("sparse columns are bounded before dense row allocation", func(t *testing.T) {
		objects := make([]map[string]int, 200)
		for i := range objects {
			objects[i] = map[string]int{fmt.Sprintf("c%d", i): i}
		}
		raw, err := json.Marshal(objects)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := parseChartData(raw, "d.json"); err == nil || !strings.Contains(err.Error(), "cells") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("empty query results and piped CSV are supported", func(t *testing.T) {
		empty, err := parseChartData([]byte(`[]`), "d.json")
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(empty)
		if err != nil || !strings.Contains(string(encoded), `"columns":[]`) {
			t.Fatalf("empty = %s, %v", encoded, err)
		}
		piped, err := parseChartData([]byte("a,b\n1,2\n"), "-")
		if err != nil || len(piped.Rows) != 1 {
			t.Fatalf("piped = %v, %v", piped, err)
		}
	})
	t.Run("malformed JSON never makes a request", func(t *testing.T) {
		for _, body := range []string{`[{"a":1}`, `[{"a":1}] trailing`, `[`, `[{"a":1},]`, `[{"a":1e500}]`, `[{"a":{"nested":[1e500]}}]`} {
			reqs, url := dataServer(t, `["write"]`, 200)
			c, _ := newTestClient(url, "tok")
			if err := c.data([]string{"push", "team/kpis", "rev", writeTemp(t, "d.json", body)}); err == nil {
				t.Fatalf("accepted %q", body)
			}
			if len(reqs()) != 0 {
				t.Fatal("malformed data reached the server")
			}
		}
	})

	t.Run("CSV non-finite values stay text and encode", func(t *testing.T) {
		reqs, url := dataServer(t, `["write"]`, 200)
		c, _ := newTestClient(url, "tok")
		if err := c.data([]string{"push", "team/kpis", "rev", writeTemp(t, "d.csv", "a\nNaN\nInf\n-Inf\n")}); err != nil {
			t.Fatal(err)
		}
		var doc chartDoc
		if err := json.Unmarshal(reqs()[1].body, &doc); err != nil {
			t.Fatal(err)
		}
		if doc.Rows[0][0] != "NaN" || doc.Rows[1][0] != "Inf" || doc.Rows[2][0] != "-Inf" {
			t.Fatalf("rows = %v", doc.Rows)
		}
	})

	t.Run("stdin is bounded before parsing or authentication", func(t *testing.T) {
		if _, err := readDataFile("-", strings.NewReader(strings.Repeat("x", maxInputBytes+1))); err == nil {
			t.Fatal("accepted oversized input")
		}
	})
	t.Run("csv becomes typed rows, sent with the minted data token", func(t *testing.T) {
		reqs, url := dataServer(t, `["read","create","write"]`, 201)
		c, out := newTestClient(url, "login-tok")
		csvPath := writeTemp(t, "rev.csv", "week,revenue,region\n2026-01-05,1200.5,EU\n2026-01-12,,US\n")
		sqlPath := writeTemp(t, "rev.sql", "  select 1  \n")
		err := c.data([]string{"push", "team/kpis", "revenue", csvPath, "--sql", sqlPath, "--source", "Snowflake", "--stale-after", "6h"})
		if err != nil {
			t.Fatalf("push: %v", err)
		}
		rs := reqs()
		if len(rs) != 2 || rs[0].method != "POST" || rs[0].path != "/api/data-token/team/kpis" || rs[0].auth != "Bearer login-tok" {
			t.Fatalf("mint = %+v", rs)
		}
		put := rs[1]
		if put.method != "PUT" || put.path != "/api/_data/shared-charts/revenue" || put.auth != "Bearer data-tok" {
			t.Fatalf("put = %+v", put)
		}
		var doc map[string]any
		if err := json.Unmarshal(put.body, &doc); err != nil {
			t.Fatal(err)
		}
		if got, _ := json.Marshal(doc["rows"]); string(got) != `[["2026-01-05",1200.5,"EU"],["2026-01-12",null,"US"]]` {
			t.Fatalf("rows = %s", got)
		}
		if doc["sql"] != "select 1" || doc["source"] != "Snowflake" || doc["staleAfter"] != float64(21600) || doc["rowCount"] != float64(2) {
			t.Fatalf("doc = %v", doc)
		}
		if doc["refreshedAt"] == "" {
			t.Fatal("refreshedAt missing")
		}
		if !strings.Contains(out.String(), "✓ Pushed revenue (2 rows) to team/kpis") {
			t.Fatalf("out = %q", out.String())
		}
	})

	t.Run("an array of objects keeps key order and fills missing keys with null", func(t *testing.T) {
		doc, err := parseChartData([]byte(`[{"b":1,"a":"x"},{"a":"y","c":true}]`), "x.json")
		if err != nil {
			t.Fatal(err)
		}
		if strings.Join(doc.Columns, ",") != "b,a,c" {
			t.Fatalf("columns = %v", doc.Columns)
		}
		if got, _ := json.Marshal(doc.Rows); string(got) != `[[1,"x",null],[null,"y",true]]` {
			t.Fatalf("rows = %s", got)
		}
	})

	t.Run("columns and rows JSON must be rectangular", func(t *testing.T) {
		if _, err := parseChartData([]byte(`{"columns":["a","b"],"rows":[[1]]}`), "x.json"); err == nil {
			t.Fatal("want error for a short row")
		}
		if _, err := parseChartData([]byte(`{"nope":1}`), "x.json"); err == nil {
			t.Fatal("want error without columns")
		}
	})

	t.Run("a read-only viewer is told only the owner can push", func(t *testing.T) {
		reqs, url := dataServer(t, `["read","create"]`, 200)
		c, _ := newTestClient(url, "tok")
		err := c.data([]string{"push", "team/kpis", "rev", writeTemp(t, "d.csv", "a\n1\n")})
		if err == nil || !strings.Contains(err.Error(), "only its owner") {
			t.Fatalf("err = %v", err)
		}
		if len(reqs()) != 1 {
			t.Fatalf("must not PUT without write: %+v", reqs())
		}
	})

	t.Run("oversized data is refused before any request", func(t *testing.T) {
		reqs, url := dataServer(t, `["write"]`, 200)
		c, _ := newTestClient(url, "tok")
		big := "a\n" + strings.Repeat("xxxxxxxxxx\n", 12_000)
		err := c.data([]string{"push", "team/kpis", "rev", writeTemp(t, "d.csv", big)})
		if err == nil || !strings.Contains(err.Error(), "Aggregate further") {
			t.Fatalf("err = %v", err)
		}
		if len(reqs()) != 0 {
			t.Fatalf("requests = %+v", reqs())
		}
	})

	t.Run("bad arguments are usage errors, checked before login", func(t *testing.T) {
		c, _ := newTestClient("http://unused", "")
		for _, argv := range [][]string{
			nil,
			{"pull", "a/b", "c", "d"},
			{"push", "a/b", "c"},
			{"push", "nospace", "c", "d"},
			{"push", "a/b", "bad id", "d"},
			{"push", "a/b", "c", "d", "--bogus", "1"},
		} {
			if err := c.data(argv); err == nil || strings.Contains(err.Error(), "Not logged in") {
				t.Fatalf("%v: err = %v", argv, err)
			}
		}
		err := c.data([]string{"push", "a/b", "c", writeTemp(t, "d.csv", "a\n1\n"), "--stale-after", "soon"})
		if err == nil || !strings.Contains(err.Error(), "--stale-after") {
			t.Fatalf("err = %v", err)
		}
	})
}
