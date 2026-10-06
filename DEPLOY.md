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

## Adding another login provider (including Ory)

Browser authentication is an adapter boundary. The app uses `/api/auth/login`,
`/api/auth/callback`, and `/api/auth/logout`; the provider label comes from
`/api/config`. Existing `/api/auth/workos` links remain supported.

To add Ory:

1. Add `packages/api/src/lib/ory.ts` implementing `BrowserAuthProvider` from
   `lib/auth-provider.ts`. Its `start` redirects to the hosted login with an
   allowlisted, absolute `return_to` pointing to `/api/auth/callback`. Carry the
   intended app path in a signed, short-lived cookie, rather than accepting an
   arbitrary redirect from the browser. The interface does not require OAuth
   codes or state: `complete` may verify an Ory cookie through a server-side
   `/sessions/whoami` request instead.
2. Return normalized `IdpClaims`: the stable identity id, email, verified-email
   status, and optional name/photo. Require an active, unexpired session and
   verified email matching the identity; never trust browser-supplied profile
   fields. Bound network requests with a timeout and deny on provider errors.
   Ory traits alone are not proof that an email is verified: use verified
   addresses or the organization's documented, enforced identity policy.
3. Select the adapter in `resolveBrowserAuthProvider`, and add its environment
   bindings/configuration. Selection must be explicit when multiple providers
   are configured; do not silently fall back to WorkOS after an Ory error.

The shared pipeline checks org domains/admins/invites, links the existing local
user by verified email, creates a Postplan session, and records invite use.
Provider subjects are namespaced; historical WorkOS subjects stay unchanged.
Local user ids, spaces, sites, comments, and roles survive a provider switch.
There is no schema migration required to add the adapter. The `googleId` column
is a legacy name for the provider subject; `workosUserId` is WorkOS-only audit
metadata. Do not use either as the local user id.

Two optional hooks complete the browser lifecycle:

- `validateSession(c, user)`: check Ory on authenticated browser requests and
  bind its verified identity to this local user, so central logout/revocation
  takes effect. Returning false or throwing denies access. Without this hook,
  the app-owned session retains its normal 30-day lifetime and local revocation.
- `logout(c)`: resolve a trusted Ory browser logout URL. The SPA follows the
  returned URL after local logout. Throw on provider failure so the app does not
  claim sign-out completed. The hook runs for requests carrying an app browser-session cookie;
  bearer CLI logout continues to revoke only that CLI token.

CLI browser approval and API keys stay app-owned, so changing the login provider
requires no CLI changes. Central Ory revocation does not by itself revoke these
credentials; Postplan's local access-revocation flow handles them. A shared
organization provider should omit `onDenied`: denying access to one Postplan
instance must never delete a company-wide identity. `recordLogin` is optional
provider audit metadata; normal invite timestamps are handled by the app.

For a shared-domain cookie setup, use an app hostname under
`company.example`, configure permitted login/logout return URLs, and **keep the
uploaded-content origin outside `company.example`**. A separate subdomain is not
sufficient isolation from a `Domain=company.example` authentication cookie. Localhost
and apps on another domain need a supported proxy/OIDC setup rather than an
assumption that the shared cookie will arrive.

`routes/__tests__/browser-auth.test.ts` demonstrates a cookie-based adapter
using the shared routes, verified-email linking, access gates, logout, and CLI
approval. WorkOS handshake and live-session hook regressions are covered in
`auth-workos.test.ts`. Actual Ory deployment configuration and a real-session
integration check are still required when adding that adapter.

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

## Backups and recovery

D1 Time Travel protects database history automatically on production databases (7 days on Workers Free, 30 days on Workers Paid). It does not restore R2 files. Postplan's deployment versions retain earlier files until site/space deletion; they are not an independent backup. See [Cloudflare's Time Travel guide](https://developers.cloudflare.com/d1/reference/time-travel/).

Run the **Recovery check** workflow manually in GitHub Actions to verify that the configured live D1 database exposes current and one-day-old recovery bookmarks, and to count enabled R2 lock rules. It uses the existing deployment secret and instance variables, makes only metadata GETs, and logs no application data or bookmarks. Locally, run `bun scripts/check-recovery.ts` with `CLOUDFLARE_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, and `CF_R2_BUCKET` set. The token needs D1 read and R2 bucket metadata access. A new database may not have one day of history yet.

This check cannot establish that an independent object backup exists or that a restore works. Bucket locks protect selected objects from deletion; enabling them on the serving bucket can prevent normal site deletion and failed-upload cleanup. Keep retention policies on a separate backup destination.

For a complete recovery checkpoint:

1. Pause all writes at the instance ingress, including deploys, comments, site/space deletion, and `postplan.db` mutations. Wait for in-flight requests to finish. Postplan has no built-in maintenance switch.
2. Export D1 with `bunx wrangler d1 export <database-name> --remote --output <checkpoint>/database.sql` using your instance config. Copy the entire R2 bucket, preserving exact keys, including historical deployment files and comment audio. Use authenticated S3-compatible tooling with a private backup destination; do not mirror deletions. Record the checkpoint time, application commit, migration state, database ID, and bucket name together.
3. Encrypt and restrict the backup, retain multiple checkpoints outside the serving bucket/account, and resume writes only after both copies finish successfully.
4. Test recovery in an isolated instance: import the SQL into a fresh D1 database, restore R2 objects under their original keys, and deploy the matching application revision with separate app/content origins. Verify a current file, an older deployment version, comments, audio, sharing, and `postplan.db` data before switching traffic.

Use a fresh KV namespace and fresh session/signing secrets on recovery; users and CLI clients must log in again. Do not restore old sessions, bearer tokens, pending login flows, or revocation markers. D1 API keys are durable credentials: revoke/rotate restored keys before admitting traffic. Realtime Durable Objects are transient fan-out relays; their state is not a durable data backup.

For an in-place D1 Time Travel restore, keep a pre-restore bookmark and follow Cloudflare's procedure during a maintenance window. A database-only restore cannot recover R2 objects already deleted; choose a checkpoint with a matching object copy whenever files were lost. Never test a restore against the live instance.

## CLI releases

The `release.yml` workflow builds four native binaries, checksum files, and five npm packages from a `v<major>.<minor>.<patch>` tag. npm publishing uses GitHub OIDC with provenance; no `NPM_TOKEN` is required. Each existing npm package must authorize repository `notsuhas/postplan`, workflow `release.yml`, with publish permission in its npm trusted-publisher settings. A maintainer can configure this with `npm trust github <package> --file release.yml --repo notsuhas/postplan --allow-publish --yes`; npm requires account authentication and 2FA. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/).

Configure the launcher `@notsuhas/postplan` and each platform package (`@notsuhas/postplan-darwin-arm64`, `@notsuhas/postplan-darwin-x64`, `@notsuhas/postplan-linux-arm64`, `@notsuhas/postplan-linux-x64`) before tagging. If a publish fails partway through, rerun the release workflow: it skips versions already present on npm. Confirm all five versions are published, then smoke-test both `postplan upgrade` and an npm install on a supported platform. Keep release tags on reviewed commits from `main`.
