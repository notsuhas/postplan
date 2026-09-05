# Deploy

The short path is in [README.md](README.md#deploy). This page covers the instance files and optional integrations.

## Instance configuration

`wrangler.example.jsonc`, `wrangler.content.example.jsonc`, and `packages/web/public/_headers.example` are tracked templates. Real instance values live in the ignored `deploy.env` file.

```bash
cp deploy.example.env deploy.env
```

Fill every required value. `APP_URL` and `CONTENT_URL` must be separate HTTPS origins. Create the three write-only secrets with `openssl rand -hex 32` and store them in `deploy.env` before running setup.

```bash
scripts/setup.sh
```

Setup renders ignored Wrangler configs, applies D1 migrations, builds the web app, deploys both workers, writes their secrets, and checks `/api/config`. It is safe to rerun with the same values.

To render configs without deploying:

```bash
scripts/apply-config.sh
```

To update worker secrets without deploying:

```bash
scripts/set-secrets.sh
```

## First admin

Open `$APP_URL/login` and submit the `BOOTSTRAP_TOKEN` from `deploy.env`. It claims the first address in `SUPERADMIN_EMAILS`, then becomes inert after the first admin exists.

## WorkOS login

Create a WorkOS environment whose redirect URI is `$APP_URL/api/auth/callback`. Put its client ID and API key in `deploy.env`, then run:

```bash
scripts/wire-workos.sh
```

The script writes both secrets to the main worker, redeploys it, and checks `/api/config`. Users from `ORG_EMAIL_DOMAINS` and superadmins can join directly. External users need an invite.

## Optional shared backend

`postplan.db` stays disabled until the main worker has a separate `DATA_TOKEN_SECRET`:

```bash
openssl rand -hex 32 | bunx wrangler secret put DATA_TOKEN_SECRET -c wrangler.jsonc
```

## Optional Slack notifications

Set `SLACK_BOT_TOKEN` on the main worker. The Slack app needs `chat:write`, `users:read`, and `users:read.email`.

```bash
bunx wrangler secret put SLACK_BOT_TOKEN -c wrangler.jsonc
```

Removing the secret disables Slack delivery immediately.

## D1 read replication

Enable read replication in the Cloudflare dashboard under D1 database settings. The app already uses D1 Sessions and bookmark propagation.

## CI deploys

`.github/workflows/deploy.yml` migrates D1 and deploys both workers on pushes to `main`. Configure `CLOUDFLARE_API_TOKEN` as a repository secret and each `CF_*` value referenced by the workflow as a repository variable. Worker secrets persist across deploys and must be set separately.
