package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
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
	for scanner.Scan() {
		var r rpcReply
		if err := json.Unmarshal(scanner.Bytes(), &r); err != nil || r.JSONRPC != "2.0" {
			t.Fatalf("stdout carried a non-JSON-RPC line: %q", scanner.Text())
		}
		replies[string(r.ID)] = r
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
	if got := strings.Join(names, ","); got != "deploy,list,comments,reply,feedback,versions,rollback,delete,fork" {
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
