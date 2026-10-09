package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

type rpcReply struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

type callReply struct {
	Content []mcpTextContent `json:"content"`
	IsError bool             `json:"isError"`
}

func testConnect(baseURL, token string) func(io.Writer) *client {
	return func(out io.Writer) *client {
		c := newMCPClient(baseURL, token, out)
		c.errOut = io.Discard
		return c
	}
}

// mcpSession pipes lines through serveMCP and indexes replies by id, failing on any non-JSON-RPC stdout line.
func mcpSession(t *testing.T, connect func(io.Writer) *client, lines ...string) map[string]rpcReply {
	t.Helper()
	var out bytes.Buffer
	if err := serveMCP(strings.NewReader(strings.Join(lines, "\n")+"\n"), &out, connect); err != nil {
		t.Fatalf("serveMCP: %v", err)
	}
	replies := map[string]rpcReply{}
	scanner := bufio.NewScanner(&out)
	scanner.Buffer(nil, 4*1024*1024)
	for scanner.Scan() {
		var r rpcReply
		if err := json.Unmarshal(scanner.Bytes(), &r); err != nil || r.JSONRPC != "2.0" {
			t.Fatalf("stdout carried a non-JSON-RPC line: %q", scanner.Text())
		}
		replies[string(r.ID)] = r
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return replies
}

func toolCall(id int, name, args string) string {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": map[string]any{"name": name, "arguments": json.RawMessage(args)}})
	return string(b)
}

func callResult(t *testing.T, r rpcReply) callReply {
	t.Helper()
	if r.Error != nil {
		t.Fatalf("protocol error: %+v", r.Error)
	}
	var res callReply
	if err := json.Unmarshal(r.Result, &res); err != nil || len(res.Content) != 1 || res.Content[0].Type != "text" {
		t.Fatalf("result = %s", r.Result)
	}
	return res
}

func TestMCPSession(t *testing.T) {
	srv, st := newDeployServer(t)
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "report.html"), "<h1>hi</h1>")

	replies := mcpSession(t, testConnect(srv.URL, "tok"),
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"ping"}`,
		toolCall(4, "deploy", `{"path":"`+filepath.Join(dir, "report.html")+`","visibility":"private"}`),
		`{"jsonrpc":"2.0","id":5,"method":"nope"}`,
		toolCall(6, "nope", `{}`),
		`not json`,
	)

	var init struct {
		ProtocolVersion string `json:"protocolVersion"`
		Capabilities    struct {
			Tools *struct{} `json:"tools"`
		} `json:"capabilities"`
		ServerInfo struct {
			Name string `json:"name"`
		} `json:"serverInfo"`
	}
	if err := json.Unmarshal(replies["1"].Result, &init); err != nil || init.ProtocolVersion != "2025-06-18" || init.Capabilities.Tools == nil || init.ServerInfo.Name != "postplan" {
		t.Fatalf("initialize = %s", replies["1"].Result)
	}
	if len(replies) != 7 {
		t.Fatalf("want 7 replies (notification unanswered), got %d", len(replies))
	}

	var list struct {
		Tools []struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"inputSchema"`
			Annotations mcpAnnotations `json:"annotations"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(replies["2"].Result, &list); err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range list.Tools {
		names = append(names, tool.Name)
		if tool.InputSchema["type"] != "object" || tool.Description == "" {
			t.Fatalf("tool %s: schema=%v", tool.Name, tool.InputSchema)
		}
		if tool.Annotations.DestructiveHint != (tool.Name == "delete") {
			t.Fatalf("tool %s destructiveHint = %v", tool.Name, tool.Annotations.DestructiveHint)
		}
	}
	if got := strings.Join(names, ","); got != "deploy,list,comments,read,reply,feedback,versions,rollback,delete,fork" {
		t.Fatalf("tools = %s", got)
	}

	if string(replies["3"].Result) != "{}" {
		t.Fatalf("ping = %s", replies["3"].Result)
	}

	res := callResult(t, replies["4"])
	if res.IsError || !strings.Contains(res.Content[0].Text, `"url":"https://g/me/report"`) {
		t.Fatalf("deploy = %+v", res)
	}
	if st.visibility != "private" || st.files["report.html"] != "<h1>hi</h1>" {
		t.Fatalf("upload state = %+v", st)
	}

	if replies["5"].Error == nil || replies["5"].Error.Code != -32601 {
		t.Fatalf("unknown method = %+v", replies["5"])
	}
	if replies["6"].Error == nil || replies["6"].Error.Code != -32602 {
		t.Fatalf("unknown tool = %+v", replies["6"])
	}
	if replies["null"].Error == nil || replies["null"].Error.Code != -32700 {
		t.Fatalf("parse error = %+v", replies["null"])
	}
}

func TestMCPToolErrors(t *testing.T) {
	srv, st := newDeployServer(t)
	st.existsBody = `{"exists":true,"canReplace":true}`
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "notes.md"), "# a")

	cases := []struct {
		name, tool, args, token, want string
	}{
		{"not logged in", "list", `{}`, "", "postplan login"},
		{"relative path", "deploy", `{"path":"./a.md"}`, "tok", "absolute"},
		{"unknown argument", "versions", `{"site":"a/b","bogus":1}`, "tok", "bogus"},
		{"missing site", "versions", `{}`, "tok", "site"},
		{"existing site needs replace", "deploy", `{"path":"` + filepath.Join(dir, "notes.md") + `"}`, "tok", "replace: true"},
		{"wait timeout bounded", "feedback", `{"action":"wait","timeout_seconds":600}`, "tok", "between 1 and 50"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			replies := mcpSession(t, testConnect(srv.URL, tc.token), toolCall(1, tc.tool, tc.args))
			res := callResult(t, replies["1"])
			if !res.IsError || !strings.Contains(res.Content[0].Text, tc.want) {
				t.Fatalf("result = %+v, want isError containing %q", res, tc.want)
			}
		})
	}
	if st.uploadPath != "" {
		t.Fatalf("an existing site was uploaded without replace: %s", st.uploadPath)
	}
}

func TestMCPToolsWrapCommands(t *testing.T) {
	srv, reqs := recordingServer(t, func(r *capturedReq) (int, string) {
		switch {
		case r.path == "/api/sites/mine":
			return 200, `[{"siteSlug":"r","spaceSlug":"team","visibility":"unlisted","url":"https://g/team/r"}]`
		case strings.HasSuffix(r.path, "/replies"):
			return 200, `{}`
		case r.path == "/api/feedback?site=team%2Fr":
			return 200, `[]`
		}
		return -1, ""
	})
	// One call per session: tool calls run concurrently and recordingServer isn't goroutine-safe.
	replies := map[string]rpcReply{}
	for i, call := range []string{
		toolCall(1, "list", `{}`),
		toolCall(2, "reply", `{"site":"team/r","thread_id":"t1","message":"--dash leading","tag":"claude"}`),
		toolCall(3, "feedback", `{"action":"wait","site":"team/r","timeout_seconds":1}`),
	} {
		id := string(rune('1' + i))
		replies[id] = mcpSession(t, testConnect(srv.URL, "tok"), call)[id]
	}
	if res := callResult(t, replies["1"]); res.IsError || !strings.Contains(res.Content[0].Text, "https://g/team/r") {
		t.Fatalf("list = %+v", res)
	}
	if res := callResult(t, replies["2"]); res.IsError {
		t.Fatalf("reply = %+v", res)
	}
	if res := callResult(t, replies["3"]); res.IsError || !strings.Contains(res.Content[0].Text, "No feedback") {
		t.Fatalf("feedback wait = %+v", res)
	}
	for _, r := range *reqs {
		if strings.HasSuffix(r.path, "/replies") && !strings.Contains(string(r.body), `"[claude] --dash leading"`) {
			t.Fatalf("reply body = %s", r.body)
		}
	}
}

func TestMCPSkipsUpdateHooks(t *testing.T) {
	if runsUpdateHooks("mcp") || !runsUpdateHooks("deploy") {
		t.Fatal("update hooks must skip mcp and still run for ordinary commands")
	}
}

const modernMeta = `"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"t","version":"1"},"io.modelcontextprotocol/clientCapabilities":{}}`

func TestMCPModernProtocol(t *testing.T) {
	srv, _ := recordingServer(t, func(r *capturedReq) (int, string) { return 200, `[]` })
	replies := mcpSession(t, testConnect(srv.URL, "tok"),
		`{"jsonrpc":"2.0","id":"d","method":"server/discover","params":{`+modernMeta+`}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{`+modernMeta+`}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list","arguments":{},`+modernMeta+`}}`,
		`{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2099-01-01","io.modelcontextprotocol/clientCapabilities":{}}}}`,
		`{"jsonrpc":"2.0","id":5,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`,
		`{"jsonrpc":"2.0","id":6,"method":"server/discover"}`,
	)

	var discover struct {
		ResultType        string   `json:"resultType"`
		SupportedVersions []string `json:"supportedVersions"`
		Capabilities      struct {
			Tools *struct{} `json:"tools"`
		} `json:"capabilities"`
		TTL        *int   `json:"ttlMs"`
		CacheScope string `json:"cacheScope"`
		Meta       map[string]struct {
			Name string `json:"name"`
		} `json:"_meta"`
	}
	if err := json.Unmarshal(replies[`"d"`].Result, &discover); err != nil || discover.ResultType != "complete" ||
		strings.Join(discover.SupportedVersions, ",") != "2026-07-28" || discover.Capabilities.Tools == nil ||
		discover.TTL == nil || discover.CacheScope != "public" || discover.Meta["io.modelcontextprotocol/serverInfo"].Name != "postplan" {
		t.Fatalf("discover = %s", replies[`"d"`].Result)
	}

	var list struct {
		ResultType string            `json:"resultType"`
		Tools      []json.RawMessage `json:"tools"`
		TTL        *int              `json:"ttlMs"`
		CacheScope string            `json:"cacheScope"`
	}
	if err := json.Unmarshal(replies["2"].Result, &list); err != nil || list.ResultType != "complete" || len(list.Tools) != len(mcpTools) || list.TTL == nil || list.CacheScope != "public" {
		t.Fatalf("tools/list = %s", replies["2"].Result)
	}

	var call struct {
		ResultType string `json:"resultType"`
		callReply
	}
	if err := json.Unmarshal(replies["3"].Result, &call); err != nil || call.ResultType != "complete" || call.IsError || len(call.Content) != 1 {
		t.Fatalf("tools/call = %s", replies["3"].Result)
	}

	if e := replies["4"].Error; e == nil || e.Code != -32022 || !strings.Contains(fmt.Sprint(e.Data), "2026-07-28") {
		t.Fatalf("unsupported version = %+v", replies["4"])
	}
	if e := replies["5"].Error; e == nil || e.Code != -32602 {
		t.Fatalf("missing clientCapabilities = %+v", replies["5"])
	}
	if e := replies["6"].Error; e == nil {
		t.Fatalf("discover without _meta must error so dual-era clients fall back to initialize: %+v", replies["6"])
	}
}

// A legacy session must not pick up modern-only result fields.
func TestMCPLegacyResultsStayLegacy(t *testing.T) {
	replies := mcpSession(t, testConnect("http://unused", "tok"),
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
	)
	if !strings.Contains(string(replies["1"].Result), `"protocolVersion":"2025-11-25"`) {
		t.Fatalf("initialize should offer the newest legacy version: %s", replies["1"].Result)
	}
	if strings.Contains(string(replies["2"].Result), "resultType") {
		t.Fatalf("legacy tools/list = %s", replies["2"].Result)
	}
}

func TestMCPCancelledCallGetsNoReply(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
		io.WriteString(w, `[]`)
	}))
	t.Cleanup(srv.Close)
	inR, inW := io.Pipe()
	var out bytes.Buffer
	done := make(chan error)
	go func() { done <- serveMCP(inR, &out, testConnect(srv.URL, "tok")) }()
	fmt.Fprintln(inW, toolCall(7, "list", `{}`))
	fmt.Fprintln(inW, `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`)
	fmt.Fprintln(inW, `{"jsonrpc":"2.0","id":8,"method":"ping"}`)
	inW.Close()
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), `"id":7`) || !strings.Contains(out.String(), `"id":8`) {
		t.Fatalf("out = %s", out.String())
	}
}

func TestMCPReadTool(t *testing.T) {
	var body []byte
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/sites/") {
			fmt.Fprintf(w, `{"contentUrl":%q}`, srv.URL+"/content/")
			return
		}
		w.Write(body)
	}))
	t.Cleanup(srv.Close)
	read := func(content []byte) callReply {
		body = content
		return callResult(t, mcpSession(t, testConnect(srv.URL, "tok"), toolCall(1, "read", `{"site":"team/r","file":"index.html"}`))["1"])
	}

	if res := read([]byte("<h1>hi</h1>")); res.IsError || res.Content[0].Text != "<h1>hi</h1>" {
		t.Fatalf("read = %+v", res)
	}
	big := bytes.Repeat([]byte("é"), mcpReadLimit) // 2 bytes per rune, so the cap falls mid-file
	if res := read(big); res.IsError || !strings.Contains(res.Content[0].Text, fmt.Sprintf("[truncated: showing %d of %d bytes]", mcpReadLimit, len(big))) {
		t.Fatalf("truncation note missing: %q", res.Content[0].Text[len(res.Content[0].Text)-80:])
	}
	if res := read([]byte{0x89, 'P', 'N', 'G', 0, 1}); !res.IsError || !strings.Contains(res.Content[0].Text, "binary") {
		t.Fatalf("binary = %+v", res)
	}
}

func TestCapTextRuneBoundary(t *testing.T) {
	got, err := capText([]byte("aé"), 2) // cap lands inside é
	if err != nil || !strings.HasPrefix(got, "a\n\n[truncated: showing 1 of 3 bytes]") {
		t.Fatalf("got %q, %v", got, err)
	}
}
