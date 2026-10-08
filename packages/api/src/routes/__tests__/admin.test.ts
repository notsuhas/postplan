import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../../db/schema'
import { seedFile, seedMember, seedSite, seedSpace } from '../../test/harness'
import { authHeaders as auth, authKey, makeRouteApp, mintKey, mintUser } from '../../test/route-fixtures'

test('admin site filters apply to owners, combined filters, and pagination totals', async () => {
  const { app, db, kv, env } = makeRouteApp()
  await mintUser(db, kv, 'admin', { role: 'superadmin' })
  await mintUser(db, kv, 'owner')
  await mintUser(db, kv, 'other')
  await seedSpace(db, { id: 'space', slug: 'space', createdBy: 'owner' })
  await seedSite(db, { id: 'first', spaceId: 'space', ownerId: 'owner', slug: 'first', visibility: 'team' })
  await seedSite(db, { id: 'second', spaceId: 'space', ownerId: 'owner', slug: 'second', visibility: 'private' })
  await seedSite(db, { id: 'third', spaceId: 'space', ownerId: 'other', slug: 'third', visibility: 'team' })
  await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, 'second'))
  const list = async (query: string) => {
    const res = await app.request(`/api/admin/sites?${query}`, { headers: auth('admin') }, env)
    expect(res.status).toBe(200)
    return res.json() as Promise<{ sites: { id: string }[]; total: number }>
  }
  const owned = await list('ownerId=owner')
  expect(owned.sites.map((site) => site.id).sort()).toEqual(['first', 'second'])
  expect(owned.total).toBe(2)
  expect(await list('ownerId=owner&status=active&visibility=team')).toMatchObject({
    sites: [{ id: 'first' }],
    total: 1,
  })
  expect(await list('ownerId=owner&page=2')).toMatchObject({ sites: [], total: 2 })
  expect(await list('ownerId=missing')).toMatchObject({ sites: [], total: 0 })
  expect((await list('')).total).toBe(3)
})

describe('DELETE /api/admin/sites/:id', () => {
  test('an R2 failure leaves the site archived and retryable', async () => {
    const { app, db, kv, env, r2 } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')
    await seedSpace(db, { id: 'space', slug: 'space', createdBy: 'owner' })
    await seedMember(db, 'space', 'owner')
    await seedSite(db, { id: 'site', spaceId: 'space', ownerId: 'owner' })
    await seedFile(db, r2, 'site', { path: 'index.html', text: 'page' })
    r2.delete = async () => {
      throw new Error('R2 unavailable')
    }

    const res = await app.request('/api/admin/sites/site', { method: 'DELETE', headers: auth('admin') }, env)

    expect(res.status).toBe(500)
    expect((await db.select().from(sites).where(eq(sites.id, 'site')))[0].status).toBe('archived')
  })
})

describe('POST /api/admin/users/:id/revoke-cli', () => {
  test('a superadmin API key cannot enter the human admin plane', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    const secret = await mintKey(db, 'admin')

    const res = await app.request('/api/admin/users', { headers: authKey(secret) }, env)
    expect(res.status).toBe(403)
  })

  test('CASE-16: also revokes the user’s D1 API keys — the key stops authenticating afterwards', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')
    const secret = await mintKey(db, 'owner')

    // Sanity: the key authenticates before the kill-switch runs.
    const before = await app.request('/api/api-keys', { headers: authKey(secret) }, env)
    expect(before.status).toBe(200)

    const res = await app.request('/api/admin/users/owner/revoke-cli', { method: 'POST', headers: auth('admin') }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // The key must stop AUTHENTICATING — not merely have a column changed.
    const after = await app.request('/api/api-keys', { headers: authKey(secret) }, env)
    expect(after.status).toBe(401)
  })

  // The slice added D1-key revocation ALONGSIDE the pre-existing KV sweep, and nothing anywhere
  // characterized that sweep — deleting revokeUserCliTokens from the route left the whole suite
  // green. Both halves of the kill-switch belong under test, or offboarding can silently start
  // leaving CLI tokens live.
  test('still revokes the user’s KV CLI tokens — both halves of the kill-switch', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')

    const before = await app.request('/api/api-keys', { headers: auth('owner') }, env)
    expect(before.status).toBe(200)

    await app.request('/api/admin/users/owner/revoke-cli', { method: 'POST', headers: auth('admin') }, env)

    const after = await app.request('/api/api-keys', { headers: auth('owner') }, env)
    expect(after.status).toBe(401)
    expect(await kv.get('cli:tok-owner')).toBeNull()
  })

  test('idempotent: a second call is a no-op, and a user with no keys is fine', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'nokeys')

    const first = await app.request(
      '/api/admin/users/nokeys/revoke-cli',
      { method: 'POST', headers: auth('admin') },
      env,
    )
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })

    const second = await app.request(
      '/api/admin/users/nokeys/revoke-cli',
      { method: 'POST', headers: auth('admin') },
      env,
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ ok: true })
  })

  test('does not touch another user’s keys', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'owner')
    await mintUser(db, kv, 'other')
    const otherSecret = await mintKey(db, 'other')

    await app.request('/api/admin/users/owner/revoke-cli', { method: 'POST', headers: auth('admin') }, env)

    const res = await app.request('/api/api-keys', { headers: authKey(otherSecret) }, env)
    expect(res.status).toBe(200)
  })
})
