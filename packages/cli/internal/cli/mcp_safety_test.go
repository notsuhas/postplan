package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestPullMarkerReaderBoundsHiddenFiles(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, pullMarkerDir)
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, pullMarkerFile)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, ok := readPullMarker(root); ok {
		t.Fatal("directory treated as marker")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte(" "), maxPullMarkerBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := readPullMarker(root); ok {
		t.Fatal("oversized marker accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "external.json")
	if err := os.WriteFile(target, []byte(`{"space":"a","name":"b","contentVersion":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, path); err != nil {
		t.Fatal(err)
	}
	if _, ok := readPullMarker(root); ok {
		t.Fatal("symlink marker accepted")
	}
}

func TestMCPIDsMustBeIntegerOrString(t *testing.T) {
	for _, raw := range []string{"1.5", "1e3", "{}", "null"} {
		if string(validID(json.RawMessage(raw))) != "null" {
			t.Fatalf("accepted id %s", raw)
		}
	}
}

func TestMCPBoundsConcurrentCalls(t *testing.T) {
	var out bytes.Buffer
	var wg sync.WaitGroup
	s := &mcpServer{enc: json.NewEncoder(&out), inFlight: map[string]context.CancelFunc{}}
	for i := range mcpMaxCalls {
		s.inFlight[fmt.Sprint(i)] = func() {}
	}
	s.receive([]byte(toolCall(9, "list", `{}`)), &wg)
	var response rpcReply
	if err := json.Unmarshal(out.Bytes(), &response); err != nil || response.Error == nil || response.Error.Code != -32000 || string(response.ID) != "9" {
		t.Fatalf("unbounded tool concurrency: %s", out.Bytes())
	}
	if len(s.inFlight) != mcpMaxCalls {
		t.Fatal("rejecting excess calls must preserve active calls")
	}
}

func TestCapTextPreservesReplacementRuneAndRejectsBinarySuffix(t *testing.T) {
	if got, err := capText([]byte("a\ufffdz"), 4); err != nil || !strings.HasPrefix(got, "a\ufffd\n") {
		t.Fatalf("valid replacement rune was removed: %q, %v", got, err)
	}
	if _, err := capText([]byte{'a', 'b', 0}, 2); err == nil {
		t.Fatal("a binary suffix must be detected before truncation")
	}
}

func TestMCPInvalidRequests(t *testing.T) {
	for _, message := range []string{
		`null`, `42`, `{}`, `{"jsonrpc":"2.0"}`,
		`{"jsonrpc":"1.0","method":"ping"}`,
		`{"jsonrpc":"2.0","method":null}`,
		`{"jsonrpc":"2.0","id":true,"method":"ping"}`,
		`{"jsonrpc":"2.0","id":[],"method":"ping"}`,
		`{"jsonrpc":"2.0","id":{},"method":"ping"}`,
		`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`,
	} {
		t.Run(message, func(t *testing.T) {
			replies := mcpSession(t, testConnect("http://unused", "tok"), message,
				`{"jsonrpc":"2.0","id":2,"method":"ping"}`)
			if e := replies["null"].Error; e == nil || e.Code != -32600 {
				t.Fatalf("invalid request = %+v", replies)
			}
			if string(replies["2"].Result) != "{}" {
				t.Fatalf("server did not recover: %+v", replies)
			}
		})
	}
}

func TestMCPCancelNormalizesStringID(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &mcpServer{inFlight: map[string]context.CancelFunc{`"call"`: cancel}}
	s.cancel([]byte(`{"requestId":"\u0063all"}`))
	if ctx.Err() != context.Canceled {
		t.Fatal("escaped string request id did not cancel the matching call")
	}
}

func TestFeedbackWaitBoundsClaimRequest(t *testing.T) {
	cancelled := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/claim") {
			select {
			case <-r.Context().Done():
				close(cancelled)
			case <-time.After(time.Second):
				t.Error("claim request did not inherit the wait deadline")
			}
			return
		}
		io.WriteString(w, `[{"id":"b1","site":{"space":"team","slug":"r"},"items":[]}]`)
	}))
	t.Cleanup(srv.Close)
	c, out := newTestClient(srv.URL, "tok")
	if err := c.feedbackWait([]string{"--json", "--timeout", "100ms"}); err == nil || !strings.Contains(err.Error(), "may have been claimed") || !strings.Contains(err.Error(), "--idempotency-key") {
		t.Fatalf("uncertain claim = %v", err)
	}
	if strings.TrimSpace(out.String()) == "null" {
		t.Fatal("uncertain claim reported an empty queue")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("claim request was not cancelled on timeout")
	}
}

func TestFeedbackWaitPreservesRecoveryAfterFailedClaimResponse(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{"server failure", http.StatusInternalServerError, `{"error":"response failed after claim"}`},
		{"gateway failure", http.StatusBadGateway, "upstream failed"},
		{"unreadable success", http.StatusOK, "{"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			claimKey := ""
			keys := make(chan string, 1)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/claim") {
					io.WriteString(w, `[{"id":"b1","site":{"space":"team","slug":"r"},"items":[]}]`)
					return
				}
				key := r.Header.Get("Idempotency-Key")
				mu.Lock()
				first := claimKey == ""
				if first {
					claimKey = key
				}
				matches := claimKey == key
				mu.Unlock()
				if first {
					keys <- key
					w.WriteHeader(tc.status)
					io.WriteString(w, tc.body)
					return
				}
				if !matches {
					w.WriteHeader(http.StatusConflict)
					return
				}
				io.WriteString(w, `{"id":"b1","status":"claimed","items":[]}`)
			}))
			t.Cleanup(srv.Close)
			c, out := newTestClient(srv.URL, "tok")
			err := c.feedbackWait([]string{"--json", "--timeout", "1s"})
			key := <-keys
			if err == nil || !strings.Contains(err.Error(), "postplan feedback claim b1 --idempotency-key "+key) {
				t.Fatalf("claim recovery identity lost: %v", err)
			}
			if out.Len() != 0 {
				t.Fatalf("failed claim emitted a successful queue result: %q", out.String())
			}
			if err := c.feedbackClaim([]string{"b1", "--json", "--idempotency-key", key}); err != nil {
				t.Fatalf("the supplied recovery command could not replay the claim: %v", err)
			}
			if !strings.Contains(out.String(), `"id":"b1"`) {
				t.Fatalf("recovery did not return the claimed batch: %q", out.String())
			}
		})
	}
}

func TestMCPDeploySafetyPrecedesHTTP(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	large := filepath.Join(t.TempDir(), "large.bin")
	f, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(mcpDeployMaxBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	for _, path := range []string{home, filepath.Dir(home), "/", large} {
		args := fmt.Sprintf(`{"path":%q,"replace":true}`, path)
		result := callResult(t, mcpSession(t, testConnect("http://unused", "tok"), toolCall(1, "deploy", args))["1"])
		if !result.IsError || strings.Contains(result.Content[0].Text, "http://unused") {
			t.Fatalf("deployment safety did not precede HTTP for %s: %+v", path, result)
		}
	}
	alias := filepath.Join(t.TempDir(), "home-alias")
	if err := os.Symlink(home, alias); err != nil {
		t.Fatal(err)
	}
	if _, err := localPath(alias); err == nil {
		t.Fatal("a symlink to HOME must be refused")
	}
}

func TestMCPDeployCountsTotalBytesAndSkipsNoise(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"a.bin", "b.bin", ".env", "node_modules/c.bin"} {
		path := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		f, err := os.Create(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := f.Truncate(mcpDeployMaxBytes / 2); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	if err := checkDeploySize(dir); err != nil {
		t.Fatalf("hidden and node_modules files should be excluded: %v", err)
	}
	writeFile(t, filepath.Join(dir, "extra.txt"), "x")
	if err := checkDeploySize(dir); err == nil {
		t.Fatal("the byte limit must apply to all files together")
	}
}

func TestMCPDeployRejectsGrowthAndNonRegularFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.txt")
	writeFile(t, path, "12345")
	if _, err := readDeployFile(path, 4); err == nil {
		t.Fatal("files growing beyond the remaining byte budget must be refused")
	}
	if _, err := readDeployFile(dir, mcpDeployMaxBytes); err == nil {
		t.Fatal("non-regular files must be refused")
	}
}

type failingContentTransport struct{}

func (failingContentTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	return nil, errors.New("redirect failed for " + req.URL.String())
}

func TestContentFetchRedactsNestedURLErrors(t *testing.T) {
	c, _ := newTestClient("http://unused", "tok")
	c.http.Transport = failingContentTransport{}
	_, err := c.fetchContent("https://content.example/c/SECRET-TOKEN/")
	if err == nil || strings.Contains(err.Error(), "SECRET-TOKEN") || strings.Contains(err.Error(), "content.example") {
		t.Fatalf("content URL leaked from nested request error: %v", err)
	}
}

func TestMCPCancelPreservesClaimRecovery(t *testing.T) {
	for _, modern := range []bool{false, true} {
		t.Run(fmt.Sprintf("modern=%t", modern), func(t *testing.T) {
			claimed := make(chan string, 1)
			release := make(chan struct{})
			var mu sync.Mutex
			claimKey := ""
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				key := claimKey
				firstClaim := strings.HasSuffix(r.URL.Path, "/claim") && key == ""
				if firstClaim {
					claimKey = r.Header.Get("Idempotency-Key")
					key = claimKey
				}
				mu.Unlock()
				if strings.HasSuffix(r.URL.Path, "/claim") {
					if firstClaim {
						claimed <- key
						<-release
					} else if r.Header.Get("Idempotency-Key") != key {
						w.WriteHeader(http.StatusConflict)
						return
					}
					io.WriteString(w, `{"id":"b1","status":"claimed","items":[]}`)
					return
				}
				if key != "" {
					io.WriteString(w, `[]`)
					return
				}
				io.WriteString(w, `[{"id":"b1","site":{"space":"team","slug":"r"},"items":[]}]`)
			}))
			t.Cleanup(srv.Close)
			defer close(release)
			inR, inW := io.Pipe()
			var out bytes.Buffer
			done := make(chan error, 1)
			go func() { done <- serveMCP(inR, &out, testConnect(srv.URL, "tok")) }()
			call := toolCall(7, "feedback_wait", `{"timeout_seconds":5}`)
			if modern {
				call = strings.Replace(call, `"params":{`, `"params":{`+modernMeta+`,`, 1)
			}
			fmt.Fprintln(inW, call)
			key := <-claimed
			fmt.Fprintln(inW, `{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":7}}`)
			inW.Close()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			var reply rpcReply
			if err := json.Unmarshal(out.Bytes(), &reply); err != nil || string(reply.ID) != "7" {
				t.Fatalf("claim recovery was suppressed: %s, %v", out.String(), err)
			}
			result := callResult(t, reply)
			if !result.IsError || !strings.Contains(result.Content[0].Text, "postplan feedback claim b1 --idempotency-key "+key) {
				t.Fatalf("claim recovery identity lost: %+v", result)
			}
			if modern && !strings.Contains(string(reply.Result), `"resultType":"complete"`) {
				t.Fatalf("modern recovery envelope lost: %s", reply.Result)
			}
			c, recovered := newTestClient(srv.URL, "tok")
			if err := c.feedbackClaim([]string{"b1", "--json", "--idempotency-key", key}); err != nil || !strings.Contains(recovered.String(), `"id":"b1"`) {
				t.Fatalf("recovery could not replay the claim: %s, %v", recovered.String(), err)
			}
		})
	}
}

func TestMCPCompletedToolSurvivesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &mcpServer{connect: testConnect("http://unused", "tok")}
	tool := &mcpTool{call: func(_ *client, _ json.RawMessage, _ *bytes.Buffer) (string, error) {
		cancel()
		return "Mutation completed", nil
	}}
	result, keepOnCancel := s.call(ctx, tool, json.RawMessage(`{}`))
	if !keepOnCancel || result["isError"] != false || ctx.Err() != context.Canceled {
		t.Fatalf("completed mutation lost: %+v, keepOnCancel=%t", result, keepOnCancel)
	}
}
