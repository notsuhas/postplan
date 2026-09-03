#!/usr/bin/env bash
# Wire WorkOS into a deployed instance. WORKOS_CLIENT_ID is readable from the WorkOS
# API/MCP; WORKOS_API_KEY is not — a key's secret is shown once at creation, so it has
# to be copied from the dashboard's API Keys page (or a fresh key minted there).
# Nothing here is committed: `wrangler secret put` writes to the Worker, not the repo.
#
#   WORKOS_API_KEY=sk_… WORKOS_CLIENT_ID=client_… scripts/wire-workos.sh
#
# Unset either one and glance stays bootstrap-only (the routes 404) — this script
# is the opt-in. No WORKOS_COOKIE_PASSWORD: this port uses glance's own KV session,
# not WorkOS sealed sessions.
set -euo pipefail
cd "$(dirname "$0")/../packages/api"

: "${WORKOS_API_KEY:?set WORKOS_API_KEY (from the WorkOS dashboard → API Keys)}"
: "${WORKOS_CLIENT_ID:?set WORKOS_CLIENT_ID (same page)}"

APP_URL="$(grep -oE '"APP_URL": "[^"]+"' wrangler.jsonc | cut -d'"' -f4)"
echo "==> instance: $APP_URL"
echo "==> the redirect URI this instance will send WorkOS:"
echo "    $APP_URL/api/auth/callback"
echo "    It must be listed under Redirects in the WorkOS dashboard, or the"
echo "    handshake fails with an invalid-redirect error."
echo

printf '%s' "$WORKOS_API_KEY"   | bunx wrangler secret put WORKOS_API_KEY   >/dev/null
printf '%s' "$WORKOS_CLIENT_ID" | bunx wrangler secret put WORKOS_CLIENT_ID >/dev/null
echo "==> secrets set; redeploying so /api/config reports the new state"
bunx wrangler deploy >/dev/null 2>&1

echo "==> verifying"
curl -fsS --max-time 25 "$APP_URL/api/config" -H "Origin: $APP_URL"
echo
echo "    googleEnabled:true means the WorkOS button is live on /login."
