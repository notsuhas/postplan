import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { invites } from '../db/schema'
import { isAdminEmail, isOrgEmail } from '../lib/access-policy'
import { identitySubject, type BrowserAuthProvider } from '../lib/auth-provider'
import { fireAndForget } from '../lib/events'
import { findOrCreateUser } from '../lib/login'
import {
  bearerToken,
  createSession,
  destroyCliToken,
  destroySession,
  readCredential,
  restoreUserAccess,
  sessionCookiePresent,
} from '../lib/session'
import type { AppEnv, Bindings } from '../types'

/** Only application paths may be used after login, regardless of the adapter's redirect format. */
function safeLoginNext(next: string | null | undefined): string | null {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  // URL parsing removes tabs/newlines and normalizes backslashes; check the resulting origin too.
  try {
    const url = new URL(next, 'https://postplan.invalid')
    if (url.origin !== 'https://postplan.invalid' || url.pathname.startsWith('//')) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}

export function createBrowserAuthRoutes(resolve: (env: Bindings) => BrowserAuthProvider | null): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()
  const start = async (c: Parameters<BrowserAuthProvider['start']>[0]) => {
    const provider = resolve(c.env)
    if (!provider) return c.notFound()
    return provider.start(c, safeLoginNext(c.req.query('next')))
  }
  routes.get('/login', start)
  // Existing WorkOS links continue working; new clients use the provider-neutral /login route.
  routes.get('/workos', (c) => (resolve(c.env)?.id === 'workos' ? start(c) : c.notFound()))
  routes.get('/callback', async (c) => {
    const provider = resolve(c.env)
    if (!provider) return c.notFound()
    const result = await provider.complete(c)
    if (result instanceof Response) return result
    const { claims } = result
    const email = claims.email.trim().toLowerCase()
    if (!claims.sub || !email || !claims.email_verified) return c.redirect('/login?error=denied')

    if (!isAdminEmail(c.env, email) && !isOrgEmail(c.env, email)) {
      const invited = await c.get('db').select().from(invites).where(eq(invites.email, email)).limit(1)
      if (!invited[0]) {
        await fireAndForget(c, provider.onDenied?.(c, claims).catch(() => {}) ?? Promise.resolve())
        return c.redirect('/login?error=not_invited')
      }
    }

    const user = await findOrCreateUser(
      c.get('db'),
      c.env,
      { ...claims, sub: identitySubject(provider.id, claims.sub) },
      email,
    )
    await restoreUserAccess(c.env.POSTPLAN_SESSIONS, user.id)
    await createSession(c, user)
    await fireAndForget(
      c,
      (async () => {
        try {
          await c
            .get('db')
            .update(invites)
            .set({ usedAt: sql`coalesce(${invites.usedAt}, ${Date.now()})` })
            .where(eq(invites.email, email))
            .run()
          await provider.recordLogin?.(c, claims)
        } catch {
          // Audit metadata must not prevent an otherwise successful sign-in.
        }
      })(),
    )
    return c.redirect(safeLoginNext(result.next) ?? '/dashboard')
  })
  routes.post('/logout', async (c) => {
    // This route runs neither requireAuth nor requireSameOrigin's cookie gate, so the credential is
    // resolved directly. A `glk_` API key is not a session — `postplan logout` is the wrong verb for
    // it (a key is revoked from the keys screen, not by logging out) — so report that rather than
    // silently doing nothing: destroyCliToken below is a KV delete and no-ops on a D1 key, and a
    // false { ok: true } would tell the caller a credential was revoked when it was not.
    const credential = await readCredential(c)
    if (credential?.kind === 'key') {
      return c.json(
        { error: 'not_a_session', message: 'This is an API key — revoke it from the keys screen, not logout.' },
        400,
      )
    }

    const redirectTo = sessionCookiePresent(c) && !bearerToken(c) ? await resolve(c.env)?.logout?.(c) : undefined
    await destroySession(c)
    // `postplan logout` authenticates with a Bearer CLI token and no cookie, so also revoke that
    // token server-side — otherwise the logged-out CLI credential stays valid for its full 30d TTL.
    const token = bearerToken(c)
    if (token) await destroyCliToken(c, token)
    return c.json(redirectTo ? { ok: true, redirectTo } : { ok: true })
  })

  return routes
}
