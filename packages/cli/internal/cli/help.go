package cli

import "fmt"

func printHelp() {
	fmt.Println(`postplan — publish files, collect review feedback, and iterate

Usage:
  postplan <command> [options]

Commands:
  login          Sign in through the browser
  deploy         Publish a file or folder
  list           List your sites
  delete         Delete a site
  move           Move a site to another space
  fork           Copy a site into a space you can edit
  comments       Read review threads
  reply          Reply to a review thread
  read           Read or pull deployed source
  notifications  Read review notifications
  versions       List a site's deployment history
  rollback       Restore an earlier deployment as a new version
  skill          Install the bundled agent skill
  upgrade        Install the latest CLI release
  version        Print the CLI version
  logout         Remove the stored session

Run "postplan help <command>" for options and examples.`)
}

func printCommandHelp(command string) bool {
	help := map[string]string{
		"login": `Usage: postplan login

Opens a browser and stores the approved session locally.`,
		"deploy": `Usage: postplan deploy <path> [options]

Options:
  --space <slug>       Target space; defaults to your personal space
  --name <slug>        Site name; defaults to the file or folder name
  --visibility <tier>  unlisted, private, members, or team
  --include-hidden     Include dotfiles; secrets may be published
  --yes                Replace an existing site without prompting
  --json               Print one machine-readable result

Example:
  postplan deploy ./report --visibility private --yes --json`,
		"list": `Usage: postplan list [--json]

Example:
  postplan list --json`,
		"delete": `Usage: postplan delete <space/site> [--yes] [--dry-run]

Example:
  postplan delete team/old-report --dry-run`,
		"skill": `Usage: postplan skill install [--target <name>] [--dry-run]

Targets: auto, all, agents, claude, codex, cursor, opencode

Example:
  postplan skill install --target auto`,
		"move": `Usage: postplan move <space/site> <new-space>

Example:
  postplan move personal/report team`,
		"fork": `Usage: postplan fork <space/site> [--space <slug>] [--name <slug>]

Example:
  postplan fork team/report --name report-draft`,
		"comments": `Usage: postplan comments <space/site> [--file <path>] [--open] [--json]

Example:
  postplan comments team/report --open --json`,
		"reply": `Usage: postplan reply <space/site> <thread-id> [message] [--tag <label> | --no-tag]

Example:
  printf '%s\n' 'Fixed.' | postplan reply team/report thread-id`,
		"read": `Usage: postplan read <space/site> [--file <path>] [--pull <dir>]

Example:
  postplan read team/report --pull ./report`,
		"notifications": `Usage: postplan notifications [--read] [--json]

Example:
  postplan notifications --json`,
		"versions": `Usage: postplan versions <space/site> [--json]

Example:
  postplan versions team/report --json`,
		"rollback": `Usage: postplan rollback <space/site> <version> [--yes] [--json]

Example:
  postplan rollback team/report 2 --yes --json`,
		"upgrade": `Usage: postplan upgrade`,
		"version": `Usage: postplan version`,
		"logout":  `Usage: postplan logout`,
	}
	text, ok := help[command]
	if ok {
		fmt.Println(text)
	}
	return ok
}
