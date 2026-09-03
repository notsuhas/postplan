// Package main is the glance CLI binary. It stays deliberately thin: the release build stamps
// `version` here via -ldflags "-X main.version=…", and everything else lives in internal/cli so
// the command surface is testable as a library rather than only through a built binary.
package main

import (
	"os"

	"glance/internal/cli"
)

var version = "0.0.0-dev"

func main() {
	cli.Version = version
	cli.Run(os.Args[1:])
}
