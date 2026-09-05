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

if [[ -f deploy.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./deploy.env
  set +a
fi
: "${APP_URL:?}" "${CONTENT_URL:?}" "${SUPERADMIN_EMAILS:?}" "${ORG_EMAIL_DOMAINS:?}" "${D1_DATABASE_ID:?}" "${KV_NAMESPACE_ID:?}"
: "${WORKER_NAME:=postplan}" "${CONTENT_WORKER_NAME:=postplan-content}" "${D1_DATABASE_NAME:=postplan-db}"
: "${R2_BUCKET:=postplan-files}"
[[ "$APP_URL" != "$CONTENT_URL" ]] || { echo "APP_URL and CONTENT_URL must use separate origins"; exit 1; }

python3 - "$APP_URL" "$CONTENT_URL" "$SUPERADMIN_EMAILS" "$ORG_EMAIL_DOMAINS" "$D1_DATABASE_ID" "$KV_NAMESPACE_ID" \
  "$WORKER_NAME" "$CONTENT_WORKER_NAME" "$D1_DATABASE_NAME" "$R2_BUCKET" <<'PY'
import json, re, sys
from urllib.parse import urlsplit

app, content, admins, org_domains, d1, kv, worker, content_worker, d1_name, bucket = sys.argv[1:11]

def host(origin):
    parsed = urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise SystemExit(f'invalid HTTPS origin: {origin}')
    if parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise SystemExit(f'origin must not contain a path, query, or fragment: {origin}')
    return parsed.netloc

app_host, content_host = host(app), host(content)

def replace_value(source, key, value, count=0):
    pattern = rf'("{re.escape(key)}"\s*:\s*)"[^"]*"'
    return re.sub(pattern, lambda match: match.group(1) + json.dumps(value), source, count=count)

def render(example, real, host, name):
    s = open(example).read()
    s = replace_value(s, 'name', name, count=1)
    s = replace_value(s, 'database_name', d1_name)
    s = replace_value(s, 'bucket_name', bucket)
    s = replace_value(s, 'APP_URL', app)
    s = replace_value(s, 'CONTENT_URL', content)
    s = replace_value(s, 'SUPERADMIN_EMAILS', admins)
    s = replace_value(s, 'ORG_EMAIL_DOMAINS', org_domains)
    s = replace_value(s, 'database_id', d1)
    s = re.sub(r'("binding": "POSTPLAN_SESSIONS", "id": )"[^"]*"', lambda m: m.group(1) + json.dumps(kv), s)
    s = re.sub(r'("routes": \[\{ "pattern": )"[^"]*"', lambda m: m.group(1) + json.dumps(host), s)
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
echo "  superadmins  $SUPERADMIN_EMAILS"
echo "  org domains  $ORG_EMAIL_DOMAINS"
echo "  workers      $WORKER_NAME, $CONTENT_WORKER_NAME"
echo "  resources    $D1_DATABASE_NAME, $R2_BUCKET"
echo "  git sees $(git status --porcelain | wc -l | tr -d ' ') changes (generated files are ignored)"
