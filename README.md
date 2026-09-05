# Postplan

> A fork of [Glance](https://github.com/plivo-labs/glance) by Plivo Inc. (MIT) — auth moved to
> WorkOS, plus an `unlisted` visibility tier. Bugs and security reports in the shared code
> belong upstream.


**Artifacts for every agent — open-source and self-hosted.** Your agent builds a self-contained page, dashboard, or app and ships it to a live URL with one command — from Claude Code, Cursor, Codex, Cline, Aider, or any harness that runs a shell command. Then you review it in the browser and drop comments like a Google Doc, and the agent reads your comments and fixes it.

An open-source alternative to Claude Artifacts — except you host it, you own it, and any agent can drive it. No more screenshotting your agent's output and pasting it back into the chat.

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/glance-demo.gif" alt="Postplan demo: an agent deploys a folder to a URL, you leave review comments in the browser, and the agent reads the comments and fixes it" width="900">
</p>

```
  agent builds  →  postplan deploy → URL
       ↑                              ↓
  reads comments, fixes  ←  you comment in the browser
```

Self-hosted on **Cloudflare's free tier** — $0/month, you own the whole loop. Ships with a CLI and an agent skill, so any agent — Claude Code, Cursor, Codex, Cline, Aider — drives deploy → pull comments → reply → redeploy with no human in the copy-paste path.

Stack: Cloudflare Workers + Hono · React Router v7 · D1 · R2 · KV.

## Deploy

First enable **R2** on your account ([dashboard](https://dash.cloudflare.com) → R2 → accept terms — still free), then create the three Cloudflare resources:

```bash
bun install
bunx wrangler login
bunx wrangler d1 create postplan-db
bunx wrangler kv namespace create POSTPLAN_SESSIONS
bunx wrangler r2 bucket create postplan-files
cp deploy.example.env deploy.env
```

Fill `deploy.env` with the returned IDs, two separate HTTPS hostnames, admin email, organization email domains, and secrets generated with `openssl rand -hex 32`. Then run `scripts/setup.sh`. It renders the ignored instance configs, migrates D1, deploys both workers, sets secrets, and verifies the app. Open `/login` and use `BOOTSTRAP_TOKEN` to claim the first admin.

> Multiple Cloudflare accounts? `export CLOUDFLARE_ACCOUNT_ID=<id>` first. Manual provisioning, secrets, and optional WorkOS login: see [DEPLOY.md](DEPLOY.md).

## The app

Pick a space, drop a folder, and publish it as private, members-only, team-visible, or unlisted:

<p align="center">
  <img src="https://github.com/plivo-labs/glance/releases/download/assets-readme/dashboard.png" alt="Postplan dashboard — deploy panel and your sites" width="900">
</p>

Superadmins get usage at a postplan — users, sites, storage, page views, comments, and CLI activity.

## Audio & voice comments

Postplan is also a home for **audio** — and the review loop works by voice.

- **Serve & play** — audio files (`mp3/wav/m4a/ogg/flac/aac/webm`) serve with the right MIME type and HTTP Range, and render in a dedicated player (not the sandboxed HTML iframe), with page-anchored comments and a `[m:ss]` timestamp-insert shortcut.
- **Record → URL** — tap the mic on the dashboard, record (live waveform, pause/resume), name it, and it deploys and opens straight in the player. Uploading a file is still one tap away.
- **Voice comments** — record a voice note right in the review composer (and in replies). It's stored, transcribed best-effort with Workers AI (Whisper), and shown as a voice card: inline player + transcript + badge. The transcript is the comment body, so the CLI/agent loop still reads everything as text.

Audio sites carry a mic badge across the dashboard, and `postplan comments` prefixes voice comments with `[voice]` in the digest.

## CLI

```bash
curl -fsSL https://postplan.example.com/api/install | sh   # use your APP_URL
postplan login          # device-code flow, opens browser
postplan deploy <path>  # file or folder → publishes to your personal space
```

The installer bakes in your instance URL and installs the agent skill so coding agents can drive the CLI. Any agent that can run a shell command drives Postplan by calling the `postplan` CLI directly — it's harness-agnostic.

### Any agent, any harness

The bundled skill teaches your agent to drive Postplan. Install it into **any** harness — Claude Code, Cursor, Codex, OpenCode, Amp, and more — with the [skills.sh](https://skills.sh) installer:

```bash
npx skills add notsuhas/postplan   # installs the postplan-cli skill universally (Codex, Cursor, OpenCode, Claude Code …)
```

The `curl … /api/install | sh` line above already installs the skill for Claude Code alongside the binary. The skill only wraps the `postplan` CLI, so any shell-capable agent works with or without it.

| command | what it does |
|---|---|
| `login` | device-code flow, saves token to `~/.postplan/config.json` |
| `deploy <path> [--space <slug>] [--name <slug>] [--visibility <v>]` | uploads a file or folder (folders recurse, skip `.git`/`node_modules`) |
| `list` | your sites, with visibility + URL |
| `comments <space/slug>` | pull a site's review comments (voice comments show as `[voice]`) |
| `reply <thread>` | reply to a comment thread from the terminal |
| `delete <space/slug>` | confirms, then deletes |
| `move <space/slug> <new-space>` | moves a site (keeps files/comments/shares; URL changes) |
| `upgrade` / `version` / `logout` | self-update · print version · revoke session |

Defaults: `--space` = your personal space · `--name` = file/folder name slugified · `--visibility` = `team` (`unlisted` · `private` · `members` also available). Point at another instance with `POSTPLAN_API_URL=https://… postplan <cmd>`.

The CLI keeps itself current (once-a-day background check, atomic in-place swap). Opt out with `POSTPLAN_NO_UPDATE=1`.

## API keys & HTTP API

`postplan login` is interactive, so CI mints an **API key** at `/settings/keys` instead and exports it — `POSTPLAN_TOKEN` takes precedence over the stored config:

```bash
export POSTPLAN_TOKEN=glk_...              # shown exactly once at mint
postplan deploy ./dist                     # or call the API directly:
curl -H "Authorization: Bearer $POSTPLAN_TOKEN" https://your-instance/api/sites/mine
```

A key authenticates the control plane as you and can only ever narrow your own access: it may create and deploy sites, never delete one, and never mint or revoke another key. Full endpoint reference, request/response shapes, grant semantics and the data-token exchange: **[packages/api/API.md](packages/api/API.md)**. In-app: `/docs/api-keys`.

## Security model

- **Uploaded HTML/JS is untrusted** — served from a separate content origin (`CONTENT_URL`), so app session cookies never reach it. This is why Postplan stands up two Workers, not one.
- **Gated links** carry short-lived, user-bound HMAC tokens. `private`, `members`, and `team` require authentication; an `unlisted` URL is an anonymous possession grant.
- **Markdown** renders with raw HTML neutralized under a strict CSP, so injected `<script>` is inert.

## Shared backend — `postplan.db` (experimental, opt-in)

Hosted sites can get browser-callable persistence — no keys, no config. Off by default; an operator enables it per deploy (see [SHARED_BACKEND.md](SHARED_BACKEND.md)).

```js
// Injected automatically when the site is opened through the Postplan app; every request is
// brokered by the parent frame, so the page never holds a credential.
const notes = postplan.db.collection('notes')
await notes.create({ text: 'hello' })   // create · list · get · put · delete
```

Docs are JSON ≤100KB in named collections. Every viewer can create and read their own docs; `shared-*` collections are readable by all viewers; the site owner reads everything and can moderate. Access is re-checked live, so revoking a share cuts data access immediately.

## Layout

```
packages/api   Hono Worker — /api/* + file serving, ships the React app as static assets
packages/web   Vite + React Router v7
packages/cli   `postplan` CLI (Go) — `cmd/postplan` is the binary, `internal/cli` the command surface
```

Local dev: `bun install && bun run db:migrate:local && bun run dev` (main :8787 + content :8788 + vite :5173), then open http://localhost:5173. CI auto-deploys both workers on push to `main`.
