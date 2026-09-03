#!/usr/bin/env bash
# Push the secrets in deploy.env onto the deployed workers.
#
# Secrets live on the WORKER, not in the config, so a rename or a fresh provision starts with none
# — which presents as `googleEnabled:false` and `bootstrapAvailable:false` on an otherwise healthy
# deploy. Re-runnable; wrangler overwrites.
#
# CONTENT_TOKEN_SECRET goes on BOTH workers and must match: the app signs gated content URLs with
# it and the content origin verifies them. SESSION_SECRET is read only by the app.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"
[[ -f deploy.env ]] || { echo "deploy.env missing"; exit 1; }
set -a; . ./deploy.env; set +a
: "${SESSION_SECRET:?}" "${CONTENT_TOKEN_SECRET:?}"

put() { printf '%s' "$2" | bunx wrangler secret put "$1" -c "$3" >/dev/null && echo "  $1 -> $(basename "$3")"; }

put SESSION_SECRET       "$SESSION_SECRET"       wrangler.jsonc
put CONTENT_TOKEN_SECRET "$CONTENT_TOKEN_SECRET" wrangler.jsonc
put CONTENT_TOKEN_SECRET "$CONTENT_TOKEN_SECRET" wrangler.content.jsonc
[[ -n "${BOOTSTRAP_TOKEN:-}" ]]   && put BOOTSTRAP_TOKEN   "$BOOTSTRAP_TOKEN"   wrangler.jsonc
[[ -n "${WORKOS_API_KEY:-}" ]]    && put WORKOS_API_KEY    "$WORKOS_API_KEY"    wrangler.jsonc
[[ -n "${WORKOS_CLIENT_ID:-}" ]]  && put WORKOS_CLIENT_ID  "$WORKOS_CLIENT_ID"  wrangler.jsonc
echo "  done — redeploy is not required; secrets take effect immediately"
