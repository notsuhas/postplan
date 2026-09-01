import { describe, expect, test } from 'bun:test'
import type { AppEnv } from '../types'
import { auth } from './auth'

const base = {
  APP_URL: 'https://glance.example.com',
  SESSION_SECRET: 'test-session-secret',
  SUPERADMIN_EMAIL: 'you@example.com',
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
