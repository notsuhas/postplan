import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { events } from '../db/schema'
import { bootstrapSuperadminByEmail, superadminStatus } from '../db/repo'
import { NEWEST_RELEASE_DATE } from '../whats-new/catalog'
import { requireAuth, requireControlGrant } from '../middleware/auth'
import { bootstrapDecision } from '../lib/bootstrap'
import { isOrgEmail, primarySuperadminEmail } from '../lib/access-policy'
import { findOrCreateUser } from '../lib/login'
import { resolveBrowserAuthProvider } from '../lib/auth-provider'
import { createBrowserAuthRoutes } from './browser-auth'
import { createCliToken, createDevLoginSession, createSession, isLocalAppUrl } from '../lib/session'
import type { AppEnv } from '../types'

export const auth = new Hono<AppEnv>()

// Provider-specific handshakes finish through the shared access/session pipeline.
auth.route('/', createBrowserAuthRoutes(resolveBrowserAuthProvider))

// `hasUsedCli` rides along so the dashboard can hide the CLI-install banner for anyone whose CLI
// has already made an authenticated call (an events row exists — see middleware/analytics.ts).
// limit(1) is the EXISTS check; the events_user_created index serves it.
auth.get('/me', requireAuth, async (c) => {
  const user = c.get('user')
  const used = await c
    .get('db')
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.type, 'cli'), eq(events.userId, user.id)))
    .limit(1)
  return c.json({ ...user, hasUsedCli: used.length > 0 })
})

// DEV ONLY: skip the IdP round-trip for local browser testing.
auth.post('/dev-login', async (c) => {
  if (!isLocalAppUrl(c.env.APP_URL)) return c.notFound()
  const email = primarySuperadminEmail(c.env)
  const user = await findOrCreateUser(
    c.get('db'),
    c.env,
    { sub: `dev-${email}`, email, email_verified: true, name: 'Dev User' },
    email,
  )
  await createDevLoginSession(c, user)
  return c.json({ ok: true, user })
})

// --- First-run bootstrap (token-gated, no IdP) ---
// Establishes the first superadmin on a fresh deploy. Inert (404) until BOOTSTRAP_TOKEN
// is set. The token rides in the POST body (never the URL — query strings leak via logs,
// history, and Referer). On first run there is no session cookie, so middleware
// `requireSameOrigin` is a no-op; this route does its OWN same-origin check.

// Persistent (no TTL) one-shot marker set AFTER the first bootstrap session is minted. While a
// configured superadmin exists but this is unset, the decision still allows a retry (anti-lockout);
// once set, bootstrap is 410 forever — so a still-set BOOTSTRAP_TOKEN is not a permanent credential.
const BOOTSTRAP_COMPLETE_KEY = 'bootstrap_complete'

auth.post('/bootstrap', async (c) => {
  const appOrigin = new URL(c.env.APP_URL).origin
  const sameOrigin = c.req.header('Origin') === appOrigin || c.req.header('Sec-Fetch-Site') === 'same-origin'
  if (!sameOrigin) return c.json({ error: 'csrf' }, 403)

  // One-shot lifetime op: a tighter window than the CLI default brakes token brute-force.
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (await isCliStartRateLimited(c.env.POSTPLAN_SESSIONS, `bootstrap:${ip}`, 5, 3600))
    return c.json({ error: 'rate_limited' }, 429)

  const body = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string })
  const db = c.get('db')
  const alreadyCompleted = (await c.env.POSTPLAN_SESSIONS.get(BOOTSTRAP_COMPLETE_KEY)) !== null
  const decision = await bootstrapDecision({
    expectedToken: c.env.BOOTSTRAP_TOKEN,
    providedToken: body.token,
    alreadyCompleted,
    status: () => superadminStatus(db, primarySuperadminEmail(c.env)),
  })
  if (!decision.ok) return c.json({ error: 'bootstrap_unavailable' }, decision.status)

  // Session (KV) is confirmed before the run is marked "done"; the flag is set only AFTER a
  // successful mint, so a KV failure mid-way leaves it unset and the (anti-lockout) decision
  // lets a retry recover without re-locking the deploy. Once set, bootstrap is one-shot (410).
  const email = primarySuperadminEmail(c.env)
  const user = await bootstrapSuperadminByEmail(db, email, null, NEWEST_RELEASE_DATE, isOrgEmail(c.env, email))
  await createSession(c, user)
  await c.env.POSTPLAN_SESSIONS.put(BOOTSTRAP_COMPLETE_KEY, '1')
  return c.json({ ok: true, user })
})

// --- CLI device-poll token flow ---
// CLI: POST /cli/start → open verificationUri in browser + poll /cli/poll.
// Browser (authed) confirms via POST /cli/approve → mints a 30-day CLI token.

// Crockford-ish base32: uppercase, no easily-confused chars (0/O/1/I excluded).
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const USER_CODE_LENGTH = 8
const CLI_START_RL_LIMIT = 5 // starts per window
const CLI_START_RL_TTL = 60 // window seconds

/** Display/URL-safe uppercase device code with full CSPRNG entropy. */
export function generateUserCode(length = USER_CODE_LENGTH): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let code = ''
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  return code
}

/** Minimal KV surface the throttle needs — keeps the helper unit-testable. */
interface ThrottleKv {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/**
 * Best-effort per-IP throttle on the shared sessions KV. The read-modify-write is
 * NOT atomic, so concurrent starts can slip past the limit — that is acceptable for
 * a coarse abuse brake. Returns true when the caller is over the limit.
 */
export async function isCliStartRateLimited(
  kv: ThrottleKv,
  ip: string,
  limit = CLI_START_RL_LIMIT,
  ttl = CLI_START_RL_TTL,
): Promise<boolean> {
  const key = `cli_start_rl:${ip}`
  const count = Number(await kv.get(key)) || 0
  if (count >= limit) return true
  await kv.put(key, String(count + 1), { expirationTtl: ttl })
  return false
}

auth.post('/cli/start', async (c) => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown'
  if (await isCliStartRateLimited(c.env.POSTPLAN_SESSIONS, ip)) return c.json({ error: 'rate_limited' }, 429)

  const deviceCode = crypto.randomUUID()
  const userCode = generateUserCode()
  const record = JSON.stringify({ status: 'pending', userCode })
  await c.env.POSTPLAN_SESSIONS.put(`cli_device:${deviceCode}`, record, { expirationTtl: 600 })
  await c.env.POSTPLAN_SESSIONS.put(`cli_user:${userCode}`, deviceCode, { expirationTtl: 600 })
  return c.json({
    deviceCode,
    userCode,
    verificationUri: `${c.env.APP_URL}/cli?code=${userCode}`,
    interval: 2,
    expiresIn: 600,
  })
})

auth.get('/cli/poll', async (c) => {
  const deviceCode = c.req.query('device_code')
  if (!deviceCode) return c.json({ error: 'device_code required' }, 400)
  const raw = await c.env.POSTPLAN_SESSIONS.get(`cli_device:${deviceCode}`)
  if (!raw) return c.json({ status: 'expired' }, 404)
  const rec = JSON.parse(raw) as { status: string; token?: string }
  if (rec.status !== 'complete' || !rec.token) return c.json({ status: 'pending' })
  await c.env.POSTPLAN_SESSIONS.delete(`cli_device:${deviceCode}`) // one-time read
  return c.json({ status: 'complete', accessToken: rec.token })
})

auth.post('/cli/approve', requireAuth, requireControlGrant, async (c) => {
  const { userCode } = await c.req.json<{ userCode?: string }>()
  if (!userCode) return c.json({ error: 'userCode required' }, 400)
  const deviceCode = await c.env.POSTPLAN_SESSIONS.get(`cli_user:${userCode.toUpperCase()}`)
  if (!deviceCode) return c.json({ error: 'invalid or expired code' }, 404)
  const token = await createCliToken(c, c.get('user'))
  await c.env.POSTPLAN_SESSIONS.put(`cli_device:${deviceCode}`, JSON.stringify({ status: 'complete', token }), {
    expirationTtl: 600,
  })
  await c.env.POSTPLAN_SESSIONS.delete(`cli_user:${userCode.toUpperCase()}`)
  return c.json({ ok: true })
})
