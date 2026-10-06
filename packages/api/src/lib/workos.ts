import { WorkOS } from '@workos-inc/node/worker'
import { eq } from 'drizzle-orm'
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie'
import { invites } from '../db/schema'
import type { BrowserAuthProvider, IdpClaims } from './auth-provider'
import type { Bindings } from '../types'

/** WorkOS is usable only when both credentials are configured. When false the deploy runs
 *  bootstrap-only and the WorkOS routes are inert — the same contract the Google routes had.
 *  WorkOS brokers the Google handshake with its own OAuth credentials, so there is no Google
 *  Cloud project to own here. */
export function isWorkosEnabled(env: Bindings): boolean {
  return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID)
}

/** Single source of truth for the WorkOS client. Call only when `isWorkosEnabled` — the guards
 *  above must keep undefined creds from reaching `new WorkOS`. The `/worker` entrypoint is the
 *  fetch-based build; the default one pulls node:https and will not run on workerd. */
function createWorkos(env: Bindings): WorkOS {
  if (!isWorkosEnabled(env)) throw new Error('WorkOS is not configured')
  return new WorkOS(env.WORKOS_API_KEY as string, { clientId: env.WORKOS_CLIENT_ID as string })
}

const OAUTH_COOKIE = 'postplan_oauth'

export const workosProvider: BrowserAuthProvider = {
  id: 'workos',
  signIn: { label: 'Sign in with Google', icon: 'google' },
  async start(c, next) {
    const state = crypto.randomUUID()
    const url = createWorkos(c.env).userManagement.getAuthorizationUrl({
      provider: 'GoogleOAuth',
      clientId: c.env.WORKOS_CLIENT_ID as string,
      redirectUri: `${c.env.APP_URL}/api/auth/callback`,
      state,
    })

    await setSignedCookie(c, OAUTH_COOKIE, JSON.stringify({ state, next }), c.env.SESSION_SECRET, {
      httpOnly: true,
      secure: c.env.APP_URL.startsWith('https://'),
      sameSite: 'Lax', // Strict would drop the cookie on the cross-site callback redirect
      path: '/',
      maxAge: 600,
    })
    return c.redirect(url.toString())
  },
  async complete(c) {
    const code = c.req.query('code')
    const state = c.req.query('state')
    const stored = await getSignedCookie(c, c.env.SESSION_SECRET, OAUTH_COOKIE)
    deleteCookie(c, OAUTH_COOKIE, { path: '/' })

    if (!code || !state || typeof stored !== 'string') return c.redirect('/login?error=oauth')
    let parsed: { state: string; next?: string | null }
    try {
      parsed = JSON.parse(stored)
    } catch {
      return c.redirect('/login?error=oauth')
    }
    if (parsed.state !== state) return c.redirect('/login?error=state')

    const workos = createWorkos(c.env)
    let claims: IdpClaims
    try {
      const result = await workos.userManagement.authenticateWithCode({
        code,
        clientId: c.env.WORKOS_CLIENT_ID as string,
      })
      claims = {
        sub: result.user.id,
        email: result.user.email,
        email_verified: result.user.emailVerified,
        name: [result.user.firstName, result.user.lastName].filter(Boolean).join(' ') || undefined,
        picture: result.user.profilePictureUrl ?? undefined,
      }
    } catch {
      return c.redirect('/login?error=exchange')
    }

    return { claims, next: parsed.next ?? null }
  },
  async onDenied(c, claims) {
    // This WorkOS project is owned by this instance, unlike a shared organization IdP.
    await createWorkos(c.env).userManagement.deleteUser(claims.sub)
  },
  async recordLogin(c, claims) {
    // Legacy audit column belongs to this adapter; shared login code only stamps usedAt.
    await c
      .get('db')
      .update(invites)
      .set({ workosUserId: claims.sub })
      .where(eq(invites.email, claims.email.trim().toLowerCase()))
      .run()
  },
}
