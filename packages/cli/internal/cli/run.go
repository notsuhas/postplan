package cli

import (
	"fmt"
	"os"
	"postplan/internal/config"
)

// Run is the CLI's entry point. cmd/postplan/main.go passes os.Args[1:] and the build-stamped
// version, so this package stays importable by tests without shelling out to a binary.
func Run(args []string) {
	raw := ""
	if len(args) > 0 {
		raw = args[0]
	}
	cmd := raw
	if raw == "--version" {
		cmd = "version"
	}
	var rest []string
	if len(args) > 1 {
		rest = args[1:]
	}
	if cmd == "help" || cmd == "--help" || cmd == "-h" {
		if len(rest) == 0 || !printCommandHelp(rest[0]) {
			printHelp()
		}
		return
	}
	for _, arg := range rest {
		if arg == "--help" || arg == "-h" {
			if !printCommandHelp(cmd) {
				printHelp()
			}
			return
		}
	}

	// Self-update hooks, skipped for machine-invoked commands: `upgrade` IS the updater, and `skill`
	// is run by install.sh and by the post-swap refresh child - which would otherwise consume the
	// pending "auto-updated" notice before the user ever sees it.
	if cmd != "upgrade" && cmd != "skill" {
		newClient("", "", os.Stdout).announceUpdate()
		maybeAutoUpdate()
	}

	if err := dispatch(cmd, rest); err != nil {
		fmt.Fprintln(os.Stderr, "✗ "+err.Error())
		os.Exit(1)
	}
}

var authedCmds = map[string]func(*client, []string) error{
	"deploy":        (*client).deploy,
	"list":          (*client).list,
	"delete":        (*client).del,
	"move":          (*client).move,
	"fork":          (*client).fork,
	"comments":      (*client).comments,
	"read":          (*client).read,
	"reply":         (*client).reply,
	"notifications": (*client).notifications,
	"versions":      (*client).versions,
	"rollback":      (*client).rollback,
}

func dispatch(cmd string, rest []string) error {
	switch cmd {
	case "login":
		if len(rest) != 0 {
			return fmt.Errorf("Usage: postplan login")
		}
		return newClient(config.APIBase(), "", os.Stdout).login()
	case "version":
		if len(rest) != 0 {
			return fmt.Errorf("Usage: postplan version")
		}
		fmt.Println(Version)
		return nil
	case "upgrade":
		return newClient("", "", os.Stdout).upgradeCmd(rest)
	case "skill":
		return newClient("", "", os.Stdout).skillCmd(rest)
	case "logout":
		if len(rest) != 0 {
			return fmt.Errorf("Usage: postplan logout")
		}
		// Deliberately NOT config.APIToken(): logout is a session verb and must act on the credential
		// `postplan login` stored. Letting POSTPLAN_TOKEN shadow it means an exported API key gets
		// POSTed to /api/auth/logout, which answers 400 (a key is revoked from the keys screen,
		// not by logging out) — and logout then still removes config.json, so the user's real
		// session token would be gone locally while staying valid server-side.
		cfg := config.Read()
		base, token := "", ""
		if cfg != nil {
			base, token = cfg.ApiUrl, cfg.Token
		}
		return newClient(base, token, os.Stdout).logout()
	}
	if run, found := authedCmds[cmd]; found {
		// Both halves of the credential come from the same precedence: env override, then stored
		// config. Resolving the token from the env but the URL from disk only would half-wire it —
		// a CI container with POSTPLAN_TOKEN and POSTPLAN_API_URL exported but no ~/.postplan/config.json
		// (a baked-in binary, no installer run) would pass requireAuth() on the non-empty token and
		// then fail every request with `unsupported protocol scheme ""`. config.APIBase()'s local-dev
		// fallback keeps the clean "Not logged in" path intact when neither is set: the base is
		// non-empty, the token is not, and requireAuth() catches it.
		return run(newClient(config.APIBase(), config.APIToken(), os.Stdout), rest)
	}
	printHelp()
	if cmd != "" {
		os.Exit(1)
	}
	os.Exit(0)
	return nil
}
