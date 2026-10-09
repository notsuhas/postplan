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

// Stateless per-request-metadata revision; older clients use the initialize handshake below.
const mcpModernVersion = "2026-07-28"

// Newest first; initialize echoes the client's version when supported, else offers the newest.
var mcpLegacyVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"}

const (
	metaProtocolVersion    = "io.modelcontextprotocol/protocolVersion"
	metaClientCapabilities = "io.modelcontextprotocol/clientCapabilities"
	metaServerInfo         = "io.modelcontextprotocol/serverInfo"
)

var mcpCapabilities = map[string]any{"tools": map[string]any{}}

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
	Data    any    `json:"data,omitempty"`
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
	connect   func(io.Writer) *client
	mu        sync.Mutex
	enc       *json.Encoder
	inFlight  map[string]bool // tools/call ids awaiting a reply
	cancelled map[string]bool
}

// serveMCP speaks newline-delimited JSON-RPC 2.0 on in/out until in closes; stdout carries protocol only.
func serveMCP(in io.Reader, out io.Writer, connect func(io.Writer) *client) error {
	s := &mcpServer{connect: connect, enc: json.NewEncoder(out), inFlight: map[string]bool{}, cancelled: map[string]bool{}}
	s.enc.SetEscapeHTML(false)
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
			s.reply(rpcResponse{ID: json.RawMessage("null"), Error: &rpcError{Code: -32700, Message: "Parse error"}})
			continue
		}
		if req.Method == "notifications/cancelled" {
			s.cancel(req.Params)
		}
		if len(req.ID) == 0 || string(req.ID) == "null" || req.Method == "" {
			continue // notifications and stray responses need no answer
		}
		if req.Method == "tools/call" {
			s.mu.Lock()
			s.inFlight[string(req.ID)] = true
			s.mu.Unlock()
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

// cancel suppresses the reply to an in-flight call; the command itself runs to completion.
func (s *mcpServer) cancel(params json.RawMessage) {
	var p struct {
		RequestID json.RawMessage `json:"requestId"`
	}
	if json.Unmarshal(params, &p) != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if id := string(p.RequestID); s.inFlight[id] {
		s.cancelled[id] = true
	}
}

func (s *mcpServer) reply(resp rpcResponse) {
	resp.JSONRPC = "2.0"
	s.mu.Lock()
	defer s.mu.Unlock()
	id := string(resp.ID)
	delete(s.inFlight, id)
	if s.cancelled[id] {
		delete(s.cancelled, id)
		return
	}
	if err := s.enc.Encode(resp); err != nil {
		fmt.Fprintln(os.Stderr, "postplan mcp: write failed:", err)
	}
}

func (s *mcpServer) handle(req rpcRequest) rpcResponse {
	var p struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	_ = json.Unmarshal(req.Params, &p)
	if version, modern := p.Meta[metaProtocolVersion]; modern && req.Method != "initialize" {
		return s.handleModern(req, version, p.Meta)
	}
	resp := rpcResponse{ID: req.ID}
	var result map[string]any
	switch req.Method {
	case "initialize":
		var init struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(req.Params, &init)
		version := mcpLegacyVersions[0]
		if slices.Contains(mcpLegacyVersions, init.ProtocolVersion) {
			version = init.ProtocolVersion
		}
		result = map[string]any{
			"protocolVersion": version,
			"capabilities":    mcpCapabilities,
			"serverInfo":      mcpServerInfo(),
			"instructions":    mcpInstructions,
		}
	case "server/discover":
		resp.Error = &rpcError{Code: -32602, Message: "Missing _meta." + metaProtocolVersion}
	default:
		result, resp.Error = s.dispatchCommon(req)
	}
	if resp.Error == nil {
		resp.Result = result
	}
	return resp
}

// handleModern serves one stateless 2026-07-28 request; every request carries its own version and capabilities.
func (s *mcpServer) handleModern(req rpcRequest, rawVersion json.RawMessage, meta map[string]json.RawMessage) rpcResponse {
	resp := rpcResponse{ID: req.ID}
	var version string
	if json.Unmarshal(rawVersion, &version) != nil {
		resp.Error = &rpcError{Code: -32602, Message: "_meta." + metaProtocolVersion + " must be a string"}
		return resp
	}
	if version != mcpModernVersion {
		resp.Error = &rpcError{Code: -32022, Message: "Unsupported protocol version", Data: map[string]any{
			"supported": []string{mcpModernVersion}, "requested": version,
		}}
		return resp
	}
	if _, ok := meta[metaClientCapabilities]; !ok {
		resp.Error = &rpcError{Code: -32602, Message: "Missing _meta." + metaClientCapabilities}
		return resp
	}
	var result map[string]any
	switch req.Method {
	case "server/discover":
		result = map[string]any{
			"supportedVersions": []string{mcpModernVersion},
			"capabilities":      mcpCapabilities,
			"instructions":      mcpInstructions,
		}
	case "initialize":
		resp.Error = &rpcError{Code: -32601, Message: "Method not found: initialize"}
	default:
		result, resp.Error = s.dispatchCommon(req)
	}
	if resp.Error != nil {
		return resp
	}
	if req.Method == "server/discover" || req.Method == "tools/list" {
		result["ttlMs"] = 3600000
		result["cacheScope"] = "public"
	}
	result["resultType"] = "complete"
	result["_meta"] = map[string]any{metaServerInfo: mcpServerInfo()}
	resp.Result = result
	return resp
}

// dispatchCommon handles the methods both protocol generations share.
func (s *mcpServer) dispatchCommon(req rpcRequest) (map[string]any, *rpcError) {
	switch req.Method {
	case "ping":
		return map[string]any{}, nil
	case "tools/list":
		return map[string]any{"tools": mcpTools}, nil
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &p); err != nil {
			return nil, &rpcError{Code: -32602, Message: "Invalid params: " + err.Error()}
		}
		tool := findTool(p.Name)
		if tool == nil {
			return nil, &rpcError{Code: -32602, Message: "Unknown tool: " + p.Name}
		}
		return s.call(tool, p.Arguments), nil
	}
	return nil, &rpcError{Code: -32601, Message: "Method not found: " + req.Method}
}

func mcpServerInfo() map[string]string {
	return map[string]string{"name": "postplan", "title": "Postplan", "version": Version}
}

func toolResult(text string, isError bool) map[string]any {
	return map[string]any{"content": []mcpTextContent{{Type: "text", Text: text}}, "isError": isError}
}

func (s *mcpServer) call(tool *mcpTool, args json.RawMessage) (result map[string]any) {
	var buf bytes.Buffer
	defer func() {
		if r := recover(); r != nil {
			result = toolResult(fmt.Sprint("Internal error: ", r), true)
		}
	}()
	if len(args) == 0 || string(args) == "null" {
		args = json.RawMessage("{}")
	}
	text, err := tool.call(s.connect(&buf), args, &buf)
	if err != nil {
		return toolResult(err.Error(), true)
	}
	return toolResult(text, false)
}
