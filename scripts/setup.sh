#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$ROOT/node_modules/.bin:$PATH"

note() { printf '\n==> %s\n' "$*"; }

command -v bun >/dev/null || { echo "bun not found"; exit 1; }
command -v wrangler >/dev/null || { echo "wrangler not found — run 'bun install' first"; exit 1; }
[[ -f deploy.env ]] || { echo "deploy.env missing — copy deploy.example.env and fill it in"; exit 1; }

note "Rendering instance configuration"
scripts/apply-config.sh

set -a
# shellcheck disable=SC1091
. ./deploy.env
set +a
: "${APP_URL:?}" "${CONTENT_URL:?}" "${D1_DATABASE_NAME:?}"

note "Checking Cloudflare authentication"
wrangler whoami >/dev/null 2>&1 || wrangler login

note "Applying database migrations"
wrangler d1 migrations apply "$D1_DATABASE_NAME" -c wrangler.jsonc --remote

note "Building the web app"
bun run build:web

note "Deploying workers"
wrangler deploy -c wrangler.jsonc
wrangler deploy -c wrangler.content.jsonc

note "Setting worker secrets"
scripts/set-secrets.sh

note "Verifying the deployment"
curl -fsS --max-time 25 "$APP_URL/api/config"
printf '\n\nApp: %s\nContent: %s\n' "$APP_URL" "$CONTENT_URL"
