#!/usr/bin/env bash
# Render this instance's config from deploy.env.
#
#   *.example        tracked  — the template, and where upstream's edits land
#   deploy.env       ignored  — this instance's values (repo root, never committed)
#   the real files   ignored  — generated, never hand-edited
#
# Rendering from the example rather than editing the real file in place is what keeps a public
# fork clean: git tracks only sentinels, and an upstream change to a template flows through on
# the next run instead of being silently overwritten.
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

[[ -f deploy.env ]] || { echo "deploy.env missing — copy deploy.example.env and fill it in."; exit 1; }
set -a; . ./deploy.env; set +a
: "${APP_URL:?}" "${CONTENT_URL:?}" "${SUPERADMIN_EMAIL:?}" "${D1_DATABASE_ID:?}" "${KV_NAMESPACE_ID:?}"

python3 - "$APP_URL" "$CONTENT_URL" "$SUPERADMIN_EMAIL" "${SUPERADMIN_EMAILS:-${ADMIN_EMAILS:-}}" "$D1_DATABASE_ID" "$KV_NAMESPACE_ID" <<'PY'
import re, sys
app, content, sup, admins, d1, kv = sys.argv[1:7]
app_host, content_host = app.removeprefix('https://'), content.removeprefix('https://')

def render(example, real, host):
    s = open(example).read()
    s = re.sub(r'"APP_URL": "[^"]*"',          f'"APP_URL": "{app}"', s)
    s = re.sub(r'"CONTENT_URL": "[^"]*"',      f'"CONTENT_URL": "{content}"', s)
    s = re.sub(r'"SUPERADMIN_EMAIL": "[^"]*"', f'"SUPERADMIN_EMAIL": "{sup}"', s)
    s = re.sub(r'"SUPERADMIN_EMAILS": "[^"]*"', f'"SUPERADMIN_EMAILS": "{admins}"', s)
    s = re.sub(r'"database_id": "[^"]*"',      f'"database_id": "{d1}"', s)
    s = re.sub(r'("binding": "POSTPLAN_SESSIONS", "id": ")[^"]*"', rf'\g<1>{kv}"', s)
    s = re.sub(r'"routes": \[\{ "pattern": "[^"]*"', f'"routes": [{{ "pattern": "{host}"', s)
    open(real, 'w').write(s)

render('wrangler.example.jsonc',         'wrangler.jsonc',         app_host)
render('wrangler.content.example.jsonc', 'wrangler.content.jsonc', content_host)

# The app's CSP must name the content origin it iframes and streams media from.
s = open('packages/web/public/_headers.example').read()
s = re.sub(r'https://postplan-content[A-Za-z0-9.\-]*', content, s)
open('packages/web/public/_headers', 'w').write(s)
PY

echo "rendered from deploy.env:"
echo "  app      $APP_URL"
echo "  content  $CONTENT_URL"
echo "  superadmins  $SUPERADMIN_EMAIL${SUPERADMIN_EMAILS:+, $SUPERADMIN_EMAILS}"
echo "  git sees $(git status --porcelain | wc -l | tr -d ' ') changes (generated files are ignored)"
