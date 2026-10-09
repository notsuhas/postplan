package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"postplan/internal/config"
	"slices"
	"strings"
	"sync"
)

// Newest first; initialize echoes the client's version when supported, else offers the newest.
var mcpProtocolVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const mcpInstructions = "Postplan hosts HTML, markdown and files at shareable URLs where people leave review comments. " +
	"Deploy a local path, share the returned URL, then read comments or claimed feedback batches, reply to threads, and redeploy with replace: true."

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type mcpTextContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type mcpCallResult struct {
	Content []mcpTextContent `json:"content"`
	IsError bool             `json:"isError"`
}

// mcpClient resolves credentials per call, so a `postplan login` mid-session takes effect without a restart.
func mcpClient(out io.Writer) *client {
	return newMCPClient(config.APIBase(), config.APIToken(), out)
}

// newMCPClient captures output and fails rather than prompting, since there is no terminal.
func newMCPClient(baseURL, token string, out io.Writer) *client {
	c := newClient(baseURL, token, out)
	c.in = strings.NewReader("")
	c.stdin = strings.NewReader("")
	c.stdinIsTTY = false
	c.nonInteractive = true
	c.openBrowser = func(string) {}
	return c
}

type mcpServer struct {
	connect func(io.Writer) *client
	mu      sync.Mutex
	enc     *json.Encoder
}

// serveMCP speaks newline-delimited JSON-RPC 2.0 on in/out until in closes; stdout carries protocol only.
func serveMCP(in io.Reader, out io.Writer, connect func(io.Writer) *client) error {
	s := &mcpServer{connect: connect, enc: json.NewEncoder(out)}
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	var wg sync.WaitGroup
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			s.reply(rpcResponse{ID: json.RawMessage("null"), Error: &rpcError{-32700, "Parse error"}})
			continue
		}
		if len(req.ID) == 0 || string(req.ID) == "null" || req.Method == "" {
			continue // notifications (initialized, cancelled) and stray responses need no answer
		}
		if req.Method == "tools/call" {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s.reply(s.handle(req))
			}()
			continue
		}
		s.reply(s.handle(req))
	}
	wg.Wait()
	return scanner.Err()
}

func (s *mcpServer) reply(resp rpcResponse) {
	resp.JSONRPC = "2.0"
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.enc.Encode(resp); err != nil {
		fmt.Fprintln(os.Stderr, "postplan mcp: write failed:", err)
	}
}

func (s *mcpServer) handle(req rpcRequest) rpcResponse {
	resp := rpcResponse{ID: req.ID}
	switch req.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &p)
		version := mcpProtocolVersions[0]
		if slices.Contains(mcpProtocolVersions, p.ProtocolVersion) {
			version = p.ProtocolVersion
		}
		resp.Result = map[string]any{
			"protocolVersion": version,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]string{"name": "postplan", "title": "Postplan", "version": Version},
			"instructions":    mcpInstructions,
		}
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": mcpTools}
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			resp.Error = &rpcError{-32602, "Invalid params: " + err.Error()}
			return resp
		}
		tool := findTool(p.Name)
		if tool == nil {
			resp.Error = &rpcError{-32602, "Unknown tool: " + p.Name}
			return resp
		}
		resp.Result = s.call(tool, p.Arguments)
	default:
		resp.Error = &rpcError{-32601, "Method not found: " + req.Method}
	}
	return resp
}

func (s *mcpServer) call(tool *mcpTool, args json.RawMessage) (result mcpCallResult) {
	var buf bytes.Buffer
	defer func() {
		if r := recover(); r != nil {
			result = mcpCallResult{Content: []mcpTextContent{{"text", fmt.Sprint("Internal error: ", r)}}, IsError: true}
		}
	}()
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	text, err := tool.call(s.connect(&buf), args, &buf)
	if err != nil {
		return mcpCallResult{Content: []mcpTextContent{{"text", err.Error()}}, IsError: true}
	}
	return mcpCallResult{Content: []mcpTextContent{{"text", text}}}
}
