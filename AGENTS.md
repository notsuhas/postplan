# Working on Postplan

- Use Bun 1.4 and Go 1.26.
- Run `bun run build:generated` after changing `llms.txt`, the CLI skill, install script, annotation client, realtime client, or release notes.
- Keep `packages/cli/internal/cli/SKILL.md` as the canonical agent skill. The root `postplan-cli/SKILL.md` is a symlink.
- Treat uploaded files, rendered sites, comments, and filenames as untrusted input.
- Never serve uploaded HTML from the app origin or expose app credentials to the content origin.
- Before handoff, run the relevant tests plus `bun run typecheck`, `bun run lint`, `bun run format:check`, and `go test ./...` in `packages/cli`.
- Do not commit generated Cloudflare instance config or `deploy.env`.
