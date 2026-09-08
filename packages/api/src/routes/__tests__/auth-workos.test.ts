import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { makeRouteApp } from '../../test/route-fixtures'
import type { AppEnv } from '../../types'
import { auth } from '../auth'

const base = {
  APP_URL: 'https://postplan.example.com',
  SESSION_SECRET: 'test-session-secret',
  SUPERADMIN_EMAILS: 'you@example.com',
  ORG_EMAIL_DOMAINS: 'example.com',
} as AppEnv['Bindings']

describe('GET /workos guard (creds optional)', () => {
  test('workos-route-404-without-creds: unset creds → clean 404, never a thrown 500', async () => {
    const res = await auth.request('/workos', { method: 'GET' }, base)
    expect(res.status).toBe(404)
  })

  test('workos-route-redirects-when-configured: creds set → 302 to the WorkOS authorize endpoint', async () => {
    const env = { ...base, WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_123' } as AppEnv['Bindings']
    const res = await auth.request('/workos', { method: 'GET' }, env)
    expect(res.status).toBe(302)
    const location = res.headers.get('location') ?? ''
    expect(location).toContain('api.workos.com')
    // WorkOS brokers Google with its own OAuth credentials — this deploy owns no Google project.
    expect(location).toContain('GoogleOAuth')
    expect(location).toContain('client_123')
  })

  test('GET /callback with unset creds → 404 (never constructs a WorkOS client)', async () => {
    const res = await auth.request('/callback?code=x&state=y', { method: 'GET' }, base)
    expect(res.status).toBe(404)
  })
})

describe('POST /dev-login guard', () => {
  function setup() {
    const { db, env } = makeRouteApp()
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('db', db)
      await next()
    })
    app.route('/api/auth', auth)
    return { app, env }
  }

  test('accepts localhost and rejects lookalike hosts', async () => {
    const { app, env } = setup()
    const local = await app.request(
      '/api/auth/dev-login',
      { method: 'POST' },
      { ...env, APP_URL: 'http://localhost:5173', SUPERADMIN_EMAILS: 'dev@example.com' },
    )
    const lookalike = await app.request(
      '/api/auth/dev-login',
      { method: 'POST' },
      { ...env, APP_URL: 'http://localhost.evil.example', SUPERADMIN_EMAILS: 'dev@example.com' },
    )

    expect(local.status).toBe(200)
    expect(local.headers.get('set-cookie') ?? '').toContain('__Host-postplan_session=')
    expect(lookalike.status).toBe(404)
  })

  test('remote HTTP preview gets a scoped dev cookie that authenticates only local development', async () => {
    const { app, env } = setup()
    const localEnv = {
      ...env,
      APP_URL: 'http://localhost:5173',
      SUPERADMIN_EMAILS: 'dev@example.com',
    } as AppEnv['Bindings']
    const login = await app.request(
      '/api/auth/dev-login',
      { method: 'POST', headers: { Origin: 'http://100.119.18.105:5173' } },
      localEnv,
    )

    expect(login.status).toBe(200)
    const setCookie = login.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('postplan_dev_session=')
    expect(setCookie).not.toContain('__Host-postplan_session=')
    expect(setCookie.toLowerCase()).not.toContain('secure')
    const cookie = setCookie.split(';')[0]

    const localMe = await app.request('/api/auth/me', { headers: { Cookie: cookie } }, localEnv)
    expect(localMe.status).toBe(200)
    expect(await localMe.json()).toMatchObject({ email: 'dev@example.com', role: 'superadmin' })

    const productionMe = await app.request('/api/auth/me', { headers: { Cookie: cookie } }, env)
    expect(productionMe.status).toBe(401)

    const logout = await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } }, localEnv)
    expect(logout.status).toBe(200)
    expect(logout.headers.get('set-cookie') ?? '').toContain('postplan_dev_session=;')

    const afterLogout = await app.request('/api/auth/me', { headers: { Cookie: cookie } }, localEnv)
    expect(afterLogout.status).toBe(401)
  })
})
