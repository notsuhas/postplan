import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { ApiKeyGrants } from './lib/api-key'
import type { OgCard } from './lib/og-image'

/** Worker bindings + secrets/vars. Secrets come from `.dev.vars` locally and
 *  `wrangler secret put` in prod; plain vars can live in wrangler.jsonc `vars`. */
export interface Bindings {
  POSTPLAN_DB: D1Database
  POSTPLAN_FILES: R2Bucket
  POSTPLAN_SESSIONS: KVNamespace
  ASSETS: Fetcher
  UPLOAD_LIMITER?: RateLimit
  SUMMARY_LIMITER?: RateLimit
  ASK_LIMITER?: RateLimit
  // Workers AI, used to transcribe voice comments server-side. Declared unconditionally in
  // wrangler.jsonc so production always has it bound; typed optional purely so tests and any
  // binding-less deploy degrade gracefully — voice comments still post with a transcript
  // placeholder rather than erroring (see lib/transcribe).
  AI?: Ai
  // Optional: when unset, the WorkOS routes are inert (404) and login is bootstrap-only.
  // WorkOS brokers the Google handshake with its own OAuth credentials — there is no Google
  // Cloud project to create or own.
  WORKOS_API_KEY?: string
  WORKOS_CLIENT_ID?: string
  // Optional one-shot secret gating first-superadmin bootstrap. Unset → bootstrap inert (404).
  BOOTSTRAP_TOKEN?: string
  // Optional Slack bot token (xoxb-…). Unset = kill-switch: comment notifications never fan out to
  // Slack (deliverSlack no-ops on line one). Set via `wrangler secret put SLACK_BOT_TOKEN`.
  SLACK_BOT_TOKEN?: string
  // Optional Slack app signing secret. Verifies inbound Events API requests (link_shared → unfurl);
  // unset → /api/slack/events is inert (404). Set via `wrangler secret put SLACK_SIGNING_SECRET`.
  SLACK_SIGNING_SECRET?: string
  // DI seam for Slack HTTP (mirrors summarize's injected fetchImpl): route tests set a fake fetch on
  // env to capture users.lookupByEmail / chat.postMessage without touching global fetch. Never set in
  // prod — unset → deliverSlack falls back to globalThis.fetch.
  SLACK_FETCH?: typeof fetch
  // DI seam for the unfurl-card PNG renderer (same idiom as SLACK_FETCH): route tests inject a fake
  // so the satori/resvg wasm never loads under bun. Never set in prod — unset → lib/og-render's
  // renderOgPng.
  OG_RENDER?: (card: OgCard) => Promise<Response>
  SESSION_SECRET: string
  CONTENT_TOKEN_SECRET: string
  // Optional: separate HMAC secret for the shared-backend data-plane tokens (postplan.db SDK).
  // Distinct from CONTENT_TOKEN_SECRET so a leaked content (view) token can't verify as a data
  // token. When unset, the /api/_data surface is inert (404) — the feature is opt-in per deploy.
  DATA_TOKEN_SECRET?: string
  // Optional: one hibernating Durable Object per site, fanning out postplan.db change events to
  // subscribed pages. Typed optional (like AI) so a binding-less deploy — and every test — still
  // serves mutations: the change_log is written either way, only the live push is skipped.
  SITE_ROOM?: DurableObjectNamespace
  APP_URL: string
  CONTENT_URL: string
  // Comma-separated superadmins, in addition to SUPERADMIN_EMAIL. Both bypass the invite gate and
  // both grant the `superadmin` role — there is no lesser "admin" tier, which is why this is not
  // called ADMIN_EMAILS.
  SUPERADMIN_EMAILS?: string
  // Deprecated spelling of SUPERADMIN_EMAILS, still read so an existing deploy keeps working
  // without a config edit. Remove once no instance sets it.
  ADMIN_EMAILS?: string
  SUPERADMIN_EMAIL: string
}

/** The minimal user identity stored in KV and attached to the request context. */
export interface SessionUser {
  id: string
  email: string
  name: string | null
  role: 'member' | 'superadmin'
}

// HOW the caller authenticated, resolved by readCredential (see lib/session.ts) and attached to
// the request by requireAuth. Distinct from `authKind` below: this is the full resolution
// (session cookie / KV CLI token / D1 api key), not the two-bucket analytics tag.
export type Credential =
  | { kind: 'session' | 'cli'; user: SessionUser }
  | { kind: 'key'; user: SessionUser; keyId: string; grants: ApiKeyGrants }

/** Hono context variables set by middleware. */
export interface Variables {
  db: DrizzleD1Database
  user: SessionUser
  // The resolved credential (session / cli / key), set by requireAuth. Absent on unauthenticated
  // routes.
  credential: Credential
  // Which credential authenticated the request, set by requireAuth. 'cli' = Bearer token,
  // 'web' = session cookie. Drives CLI-usage analytics. Absent on unauthenticated routes. A
  // D1-key-authenticated request is also tagged 'cli' here (no cookie + a Bearer token) — key-vs-
  // CLI analytics is a separate, not-yet-built slice (would need an events-table migration).
  authKind: 'cli' | 'web'
}

export type AppEnv = { Bindings: Bindings; Variables: Variables }
