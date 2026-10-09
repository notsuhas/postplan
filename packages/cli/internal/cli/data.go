package cli

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"postplan/internal/argparse"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	dataUsage       = "Usage: postplan data push <space/slug> <chart-id> <file.json|file.csv|-> [--sql <file>] [--source <name>] [--stale-after <duration>]"
	chartCollection = "shared-charts"
	maxChartBytes   = 100_000
	maxSQLBytes     = 20_000
	defaultStaleIn  = 24 * time.Hour
)

var chartIDRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)

// chartDoc is what <pp-chart> reads: rows as arrays (compact) plus the provenance it shows.
type chartDoc struct {
	Columns     []string `json:"columns"`
	Rows        [][]any  `json:"rows"`
	RowCount    int      `json:"rowCount"`
	SQL         string   `json:"sql,omitempty"`
	Source      string   `json:"source,omitempty"`
	RefreshedAt string   `json:"refreshedAt"`
	StaleAfter  int      `json:"staleAfter"`
}

func (c *client) data(argv []string) error {
	if len(argv) == 0 || argv[0] != "push" {
		return fmt.Errorf("%s", dataUsage)
	}
	positional, flags := argparse.ParseArgs(argv[1:], nil)
	if err := argparse.ValidateFlags(flags, "sql", "source", "stale-after"); err != nil {
		return err
	}
	if len(positional) != 3 {
		return fmt.Errorf("%s", dataUsage)
	}
	space, site, err := splitSpaceSlug(positional[0])
	if err != nil {
		return fmt.Errorf("%s", dataUsage)
	}
	chartID, file := positional[1], positional[2]
	if !chartIDRe.MatchString(chartID) {
		return fmt.Errorf("Invalid chart id %q. Use letters, digits, - or _ (max 128).", chartID)
	}

	raw, err := readDataFile(file, c.stdin)
	if err != nil {
		return err
	}
	doc, err := parseChartData(raw, file)
	if err != nil {
		return err
	}
	if p, present := flags["sql"]; present {
		sql, err := os.ReadFile(p.(string))
		if err != nil {
			return fmt.Errorf("Can't read --sql: %v", err)
		}
		if len(sql) > maxSQLBytes {
			return fmt.Errorf("--sql is over %d bytes", maxSQLBytes)
		}
		doc.SQL = strings.TrimSpace(string(sql))
	}
	if s, present := flags["source"]; present {
		doc.Source = s.(string)
	}
	stale := defaultStaleIn
	if s, present := flags["stale-after"]; present {
		if stale, err = time.ParseDuration(s.(string)); err != nil || stale <= 0 {
			return fmt.Errorf("Invalid --stale-after %q. Use a duration like 30m, 6h or 48h.", s)
		}
	}
	doc.StaleAfter = int(stale.Seconds())
	doc.RefreshedAt = time.Now().UTC().Format(time.RFC3339)

	payload, _ := json.Marshal(doc)
	if len(payload) > maxChartBytes {
		return fmt.Errorf("Chart data is %d bytes; the limit is %d. Aggregate further (fewer rows or columns) before pushing.", len(payload), maxChartBytes)
	}
	if err := c.requireAuth(); err != nil {
		return err
	}

	token, err := c.mintDataToken(space, site)
	if err != nil {
		return err
	}
	resp, err := c.authedWith(token, "PUT", "/api/_data/"+chartCollection+"/"+chartID, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if !ok(resp) {
		if resp.StatusCode == 404 {
			return fmt.Errorf("Chart %q was pushed by someone else; pick another chart id.", chartID)
		}
		return fmt.Errorf("Push failed (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	fmt.Fprintf(c.out, "✓ Pushed %s (%d rows) to %s/%s\n", chartID, doc.RowCount, space, site)
	return nil
}

// mintDataToken exchanges the CLI login for a short-lived token scoped to one site's data.
func (c *client) mintDataToken(space, site string) (string, error) {
	resp, err := c.authed("POST", "/api/data-token/"+space+"/"+site, nil, nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == 404:
		return "", fmt.Errorf("Site %s/%s not found (or postplan.db is off on this instance).", space, site)
	case resp.StatusCode == 403:
		return "", fmt.Errorf("Not allowed to push data to %s/%s. Only the site owner can, and an API key also needs a data grant for it.", space, site)
	case !ok(resp):
		return "", fmt.Errorf("Couldn't get a data token (%d): %s", resp.StatusCode, bodySlice(resp))
	}
	var out struct {
		Token string   `json:"token"`
		Caps  []string `json:"caps"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	for _, cp := range out.Caps {
		if cp == "write" {
			return out.Token, nil
		}
	}
	return "", fmt.Errorf("You can't write data to %s/%s; only its owner can.", space, site)
}

// authedWith sends a JSON request with a bearer token other than the login (the data token).
func (c *client) authedWith(token, method, path string, body io.Reader) (*http.Response, error) {
	saved := c.token
	c.token = token
	defer func() { c.token = saved }()
	return c.authed(method, path, body, map[string]string{"Content-Type": "application/json"})
}

func readDataFile(file string, stdin io.Reader) ([]byte, error) {
	if file == "-" {
		return io.ReadAll(stdin)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("Can't read %s: %v", file, err)
	}
	return b, nil
}

// parseChartData accepts CSV (by extension) or JSON: an array of objects, or {columns, rows}.
func parseChartData(raw []byte, name string) (*chartDoc, error) {
	if strings.HasSuffix(strings.ToLower(name), ".csv") {
		return parseCSV(raw)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 && trimmed[0] == '{' {
		var tbl struct {
			Columns []string `json:"columns"`
			Rows    [][]any  `json:"rows"`
		}
		if err := json.Unmarshal(trimmed, &tbl); err != nil || len(tbl.Columns) == 0 {
			return nil, fmt.Errorf("JSON must be an array of objects or {\"columns\": [...], \"rows\": [[...]]}")
		}
		for i, r := range tbl.Rows {
			if len(r) != len(tbl.Columns) {
				return nil, fmt.Errorf("Row %d has %d values; expected %d", i+1, len(r), len(tbl.Columns))
			}
		}
		return &chartDoc{Columns: tbl.Columns, Rows: nonNil(tbl.Rows), RowCount: len(tbl.Rows)}, nil
	}
	objs, err := orderedObjects(trimmed)
	if err != nil {
		return nil, fmt.Errorf("JSON must be an array of objects or {\"columns\": [...], \"rows\": [[...]]}")
	}
	var columns []string
	index := map[string]int{}
	for _, o := range objs {
		for _, f := range o {
			if _, seen := index[f.key]; !seen {
				index[f.key] = len(columns)
				columns = append(columns, f.key)
			}
		}
	}
	rows := make([][]any, len(objs))
	for i, o := range objs {
		row := make([]any, len(columns))
		for _, f := range o {
			row[index[f.key]] = f.value
		}
		rows[i] = row
	}
	return &chartDoc{Columns: columns, Rows: rows, RowCount: len(rows)}, nil
}

type field struct {
	key   string
	value any
}

// orderedObjects decodes an array of flat objects keeping each object's key order.
func orderedObjects(raw []byte) ([][]field, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil, fmt.Errorf("not an array")
	}
	var out [][]field
	for dec.More() {
		if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
			return nil, fmt.Errorf("not an object")
		}
		var obj []field
		for dec.More() {
			tok, err := dec.Token()
			if err != nil {
				return nil, err
			}
			var value any
			if err := dec.Decode(&value); err != nil {
				return nil, err
			}
			obj = append(obj, field{key: tok.(string), value: value})
		}
		if _, err := dec.Token(); err != nil {
			return nil, err
		}
		out = append(out, obj)
	}
	return out, nil
}

func parseCSV(raw []byte) (*chartDoc, error) {
	records, err := csv.NewReader(bytes.NewReader(raw)).ReadAll()
	if err != nil {
		return nil, fmt.Errorf("Can't parse CSV: %v", err)
	}
	if len(records) == 0 {
		return nil, fmt.Errorf("CSV is empty; the first row must be the column names")
	}
	rows := make([][]any, 0, len(records)-1)
	for _, rec := range records[1:] {
		row := make([]any, len(rec))
		for i, cell := range rec {
			row[i] = csvValue(cell)
		}
		rows = append(rows, row)
	}
	return &chartDoc{Columns: records[0], Rows: rows, RowCount: len(rows)}, nil
}

// csvValue turns numeric cells into numbers so charts get a quantitative axis; empty cells are null.
func csvValue(cell string) any {
	if cell == "" {
		return nil
	}
	if n, err := strconv.ParseFloat(cell, 64); err == nil {
		return n
	}
	return cell
}

func nonNil(rows [][]any) [][]any {
	if rows == nil {
		return [][]any{}
	}
	return rows
}
