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
: "${WORKER_NAME:?}" "${CONTENT_WORKER_NAME:?}" "${D1_DATABASE_NAME:?}" "${R2_BUCKET:?}"

python3 - "$APP_URL" "$CONTENT_URL" "$SUPERADMIN_EMAIL" "${SUPERADMIN_EMAILS:-${ADMIN_EMAILS:-}}" "$D1_DATABASE_ID" "$KV_NAMESPACE_ID" \
  "$WORKER_NAME" "$CONTENT_WORKER_NAME" "$D1_DATABASE_NAME" "$R2_BUCKET" <<'PY'
import re, sys
app, content, sup, admins, d1, kv, worker, content_worker, d1_name, bucket = sys.argv[1:11]
app_host, content_host = app.removeprefix('https://'), content.removeprefix('https://')

def render(example, real, host, name):
    s = open(example).read()
    # Worker and resource names are per-instance: the account may already hold a worker under the
    # template's brand name, and overwriting it would be silent and destructive.
    s = re.sub(r'"name": "[^"]*"', f'"name": "{name}"', s, count=1)
    s = re.sub(r'"database_name": "[^"]*"', f'"database_name": "{d1_name}"', s)
    s = re.sub(r'"bucket_name": "[^"]*"', f'"bucket_name": "{bucket}"', s)
    s = re.sub(r'"APP_URL": "[^"]*"',          f'"APP_URL": "{app}"', s)
    s = re.sub(r'"CONTENT_URL": "[^"]*"',      f'"CONTENT_URL": "{content}"', s)
    s = re.sub(r'"SUPERADMIN_EMAIL": "[^"]*"', f'"SUPERADMIN_EMAIL": "{sup}"', s)
    s = re.sub(r'"SUPERADMIN_EMAILS": "[^"]*"', f'"SUPERADMIN_EMAILS": "{admins}"', s)
    s = re.sub(r'"database_id": "[^"]*"',      f'"database_id": "{d1}"', s)
    s = re.sub(r'("binding": "POSTPLAN_SESSIONS", "id": ")[^"]*"', rf'\g<1>{kv}"', s)
    s = re.sub(r'"routes": \[\{ "pattern": "[^"]*"', f'"routes": [{{ "pattern": "{host}"', s)
    open(real, 'w').write(s)

render('wrangler.example.jsonc',         'wrangler.jsonc',         app_host,     worker)
render('wrangler.content.example.jsonc', 'wrangler.content.jsonc', content_host, content_worker)

# The app's CSP must name the content origin it iframes and streams media from.
s = open('packages/web/public/_headers.example').read()
s = re.sub(r'https://postplan-content[A-Za-z0-9.\-]*', content, s)
open('packages/web/public/_headers', 'w').write(s)
PY

echo "rendered from deploy.env:"
echo "  app      $APP_URL"
echo "  content  $CONTENT_URL"
echo "  superadmins  $SUPERADMIN_EMAIL${SUPERADMIN_EMAILS:+, $SUPERADMIN_EMAILS}"
echo "  workers      $WORKER_NAME, $CONTENT_WORKER_NAME"
echo "  resources    $D1_DATABASE_NAME, $R2_BUCKET"
echo "  git sees $(git status --porcelain | wc -l | tr -d ' ') changes (generated files are ignored)"
