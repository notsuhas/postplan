import { describe, expect, test } from 'bun:test'
import { getCookie } from 'hono/cookie'
import { invites, users } from '../../db/schema'
import type { BrowserAuthProvider, IdpClaims } from '../../lib/auth-provider'
import { makeRouteApp } from '../../test/route-fixtures'
import { auth } from '../auth'
import { createBrowserAuthRoutes } from '../browser-auth'

/** A cookie-based provider, deliberately without OAuth code/state or WorkOS credentials.
 * It stands in for Ory's SERVER-side whoami verifier; this fixture never trusts browser traits. */
function setup() {
  const fixture = makeRouteApp()
  let claims: IdpClaims = { sub: 'identity-1', email: 'Person@EXAMPLE.COM', email_verified: true, name: 'Person' }
  let next: string | null = '/settings/keys'
  const provider: BrowserAuthProvider = {
    id: 'ory',
    signIn: { label: 'Sign in with Company' },
    async start(c, target) {
      const url = new URL('https://auth.example.com/ui/login')
      url.searchParams.set('return_to', `${c.env.APP_URL}/api/auth/callback`)
      if (target) url.searchParams.set('next', target)
      return c.redirect(url.toString())
    },
    async complete(c) {
      if (getCookie(c, 'fake_ory_session') !== 'verified-session') return c.redirect('/login?error=oauth')
      return { claims, next }
    },
  }
  fixture.app.route(
    '/api/auth',
    createBrowserAuthRoutes(() => provider),
  )
  fixture.app.route('/api/auth', auth)
  return {
    ...fixture,
    provider,
    setClaims(value: IdpClaims) {
      claims = value
    },
    setNext(value: string) {
      next = value
    },
    login() {
      return fixture.app.request(
        '/api/auth/callback',
        { headers: { Cookie: 'fake_ory_session=verified-session' } },
        fixture.env,
      )
    },
  }
}

describe('provider-neutral browser authentication', () => {
  test('cookie provider signs in through the same session and CLI approval infrastructure', async () => {
    const f = setup()
    const login = await f.login()
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/settings/keys')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const me = await f.app.request('/api/auth/me', { headers: { Cookie: cookie } }, f.env)
    const user = (await me.json()) as { id: string; email: string }
    expect(me.status).toBe(200)
    expect(user.email).toBe('person@example.com')
    expect((await f.db.select().from(users))[0].googleId).toBe('ory:identity-1')

    const start = await f.app.request('/api/auth/cli/start', { method: 'POST' }, f.env)
    const device = (await start.json()) as { userCode: string; deviceCode: string }
    const approve = await f.app.request(
      '/api/auth/cli/approve',
      {
        method: 'POST',
        headers: { Cookie: cookie, Origin: f.env.APP_URL, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userCode: device.userCode }),
      },
      f.env,
    )
    expect(approve.status).toBe(200)
    const poll = await f.app.request(`/api/auth/cli/poll?device_code=${device.deviceCode}`, {}, f.env)
    expect(await poll.json()).toMatchObject({ status: 'complete', accessToken: expect.any(String) })
  })

  test('verified-email migration preserves the local user, role, and space', async () => {
    const f = setup()
    await f.db
      .insert(users)
      .values({ id: 'existing', email: 'person@example.com', googleId: 'user_workos_old', role: 'superadmin' })
    await f.login()
    const migrated = (await f.db.select().from(users))[0]
    expect(migrated.id).toBe('existing')
    expect(migrated.googleId).toBe('ory:identity-1')
    expect(migrated.role).toBe('superadmin')
    await f.login()
    expect(await f.db.select().from(users)).toHaveLength(1)
  })

  test('an unverified email cannot link an existing account or create a session', async () => {
    const f = setup()
    await f.db.insert(users).values({ id: 'existing', email: 'person@example.com', googleId: 'old' })
    f.setClaims({ sub: 'identity-1', email: 'person@example.com', email_verified: false })
    const response = await f.login()
    expect(response.headers.get('location')).toBe('/login?error=denied')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect((await f.db.select().from(users))[0].googleId).toBe('old')
  })

  test('external accounts still need an invite; an adapter without cleanup never deletes shared identities', async () => {
    const f = setup()
    f.setClaims({ sub: 'external', email: 'reviewer@outside.com', email_verified: true })
    expect((await f.login()).headers.get('location')).toBe('/login?error=not_invited')
    expect(await f.db.select().from(users)).toHaveLength(0)
    await f.db.insert(invites).values({ email: 'reviewer@outside.com', invitedBy: 'admin@example.com', createdAt: 1 })
    const invited = await f.login()
    expect(invited.headers.get('set-cookie')).toContain('__Host-postplan_session=')
    const row = (await f.db.select().from(invites))[0]
    expect(row.usedAt).toBeGreaterThan(1)
    expect(row.workosUserId).toBeNull()
  })

  test('provider failure does not touch local identities', async () => {
    const f = setup()
    const failed = await f.app.request('/api/auth/callback?email=person@example.com', {}, f.env)
    expect(failed.headers.get('location')).toBe('/login?error=oauth')
    expect(await f.db.select().from(users)).toHaveLength(0)
  })

  test('start and finish reject cross-origin return paths', async () => {
    const f = setup()
    for (const target of [
      '//evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\t/[',
      '/foo/..//evil.example',
    ]) {
      const start = await f.app.request(`/api/auth/login?next=${encodeURIComponent(target)}`, {}, f.env)
      expect(new URL(start.headers.get('location')!).searchParams.has('next')).toBe(false)
      f.setNext(target)
      expect((await f.login()).headers.get('location')).toBe('/dashboard')
    }
    f.setNext('/\t/postplan.invalid')
    expect((await f.login()).headers.get('location')).toBe('/')
    expect((await f.app.request('/api/auth/workos', {}, f.env)).status).toBe(404)
  })

  test('provider logout returns a browser redirect, while CLI logout only revokes its own token', async () => {
    const f = setup()
    let called = 0
    f.provider.logout = async () => {
      called++
      return 'https://auth.example.com/self-service/logout?token=one-use'
    }
    const login = await f.login()
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const logout = await f.app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Cookie: cookie, Origin: f.env.APP_URL } },
      f.env,
    )
    expect(await logout.json()).toMatchObject({
      ok: true,
      redirectTo: 'https://auth.example.com/self-service/logout?token=one-use',
    })
    expect((await f.app.request('/api/auth/me', { headers: { Cookie: cookie } }, f.env)).status).toBe(401)
    await f.kv.put('cli:token', JSON.stringify({ id: 'cli-user', email: 'person@example.com', role: 'member' }))
    expect(
      (await f.app.request('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer token' } }, f.env))
        .status,
    ).toBe(200)
    expect(await f.kv.get('cli:token')).toBeNull()
    expect(called).toBe(1)
  })

  test('a revoked local session still attempts hosted logout and reports provider failure', async () => {
    const f = setup()
    let called = false
    f.provider.logout = async () => {
      called = true
      throw new Error('provider unavailable')
    }
    const login = await f.login()
    const user = (await f.db.select().from(users))[0]
    await f.kv.put(`revoked_user:${user.id}`, '1')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const logout = await f.app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Cookie: cookie, Origin: f.env.APP_URL } },
      f.env,
    )
    expect(logout.status).toBe(500)
    expect(called).toBe(true)
  })

  test('a provider logout failure is not reported as success', async () => {
    const f = setup()
    f.provider.logout = async () => {
      throw new Error('Ory unavailable')
    }
    const login = await f.login()
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const logout = await f.app.request(
      '/api/auth/logout',
      { method: 'POST', headers: { Cookie: cookie, Origin: f.env.APP_URL } },
      f.env,
    )
    expect(logout.status).toBe(500)
    expect((await f.app.request('/api/auth/me', { headers: { Cookie: cookie } }, f.env)).status).toBe(200)
  })
})
