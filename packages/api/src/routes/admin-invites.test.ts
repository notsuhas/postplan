import { describe, expect, test } from 'bun:test'
import { invites } from '../db/schema'
import { auth, authKey, makeRouteApp, mintKey, mintUser } from '../test/route-fixtures'

// The shared fixture leaves SUPERADMIN_EMAIL unset; these routes read it, so each test that cares
// about the admin bypass sets it explicitly rather than relying on a fixture default.
const ADMIN_EMAIL = 'boss@example.com'

// The invite gate replaced the Google-Workspace `hd` check when auth moved to WorkOS: WorkOS
// brokers Google for any account, so membership is an explicit allowlist and this is the surface
// that maintains it.

const post = (body: unknown, who = 'admin') => ({
  method: 'POST',
  headers: { ...auth(who), 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('invites — who may reach the surface at all', () => {
  test('a member gets 403, not a 404 that hides whether the route exists', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'member')
    expect((await app.request('/api/admin/invites', { headers: auth('member') }, env)).status).toBe(403)
  })

  test('anonymous gets 401', async () => {
    const { app, env } = makeRouteApp()
    expect((await app.request('/api/admin/invites', {}, env)).status).toBe(401)
  })
})

describe('POST /api/admin/invites', () => {
  test('adds an address, lowercased and trimmed', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })

    const res = await app.request('/api/admin/invites', post({ email: '  NewPerson@Example.com ' }), env)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, email: 'newperson@example.com' })

    const rows = await db.select().from(invites)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe('newperson@example.com')
    // Recorded so the list can say who let them in.
    expect(rows[0]?.invitedBy).toBeTruthy()
  })

  // Re-inviting is what an operator does when they are unsure whether it took. A 409 would train
  // them to ignore errors; the intent ("this person may sign in") already holds either way.
  test('re-inviting the same address is an idempotent success, not a conflict', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await app.request('/api/admin/invites', post({ email: 'dup@example.com' }), env)
    const again = await app.request('/api/admin/invites', post({ email: 'dup@example.com' }), env)
    expect(again.status).toBe(201)
    expect(await db.select().from(invites)).toHaveLength(1)
  })

  test('junk is rejected', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    for (const email of ['', '   ', 'not-an-email', 42, null, undefined]) {
      const res = await app.request('/api/admin/invites', post({ email }), env)
      expect(res.status).toBe(400)
    }
    expect(await db.select().from(invites)).toHaveLength(0)
  })

  // An admin already bypasses the gate, so an invite row for them is a no-op that reads as if it
  // did something.
  test('inviting an admin address 409s and explains why', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    const res = await app.request('/api/admin/invites', post({ email: ADMIN_EMAIL }), {
      ...env,
      SUPERADMIN_EMAIL: ADMIN_EMAIL,
    })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('admin')
  })
})

describe('GET /api/admin/invites', () => {
  test('lists invites newest-first and names the admins who bypass the gate', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await db.insert(invites).values({ email: 'older@example.com', invitedBy: 'a@b.c', createdAt: 1000 })
    await db.insert(invites).values({ email: 'newer@example.com', invitedBy: 'a@b.c', createdAt: 2000 })

    const body = (await (
      await app.request('/api/admin/invites', { headers: auth('admin') }, { ...env, SUPERADMIN_EMAIL: ADMIN_EMAIL })
    ).json()) as {
      invites: { email: string; usedAt: number | null }[]
      admins: string[]
    }
    expect(body.invites.map((i) => i.email)).toEqual(['newer@example.com', 'older@example.com'])
    // Never signed in reads as null rather than 0 — the UI shows "hasn't signed in yet".
    expect(body.invites[0]?.usedAt).toBeNull()
    expect(body.admins).toContain(ADMIN_EMAIL)
  })
})

describe('DELETE /api/admin/invites/:email', () => {
  test('revoking also stops the credentials the invitee already holds', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    await mintUser(db, kv, 'guest')
    const secret = await mintKey(db, 'guest')
    await db.insert(invites).values({ email: 'guest@example.com', invitedBy: 'a@b.c', createdAt: 1 })

    // The key works while the invite stands.
    expect((await app.request('/api/api-keys', { headers: authKey(secret) }, env)).status).toBe(200)

    const res = await app.request(
      '/api/admin/invites/guest%40example.com',
      { method: 'DELETE', headers: auth('admin') },
      env,
    )
    expect(res.status).toBe(200)
    expect(await db.select().from(invites)).toHaveLength(0)

    // Access must actually STOP — otherwise removal is cosmetic until the session TTL lapses.
    expect((await app.request('/api/api-keys', { headers: authKey(secret) }, env)).status).toBe(401)
    expect((await app.request('/api/api-keys', { headers: auth('guest') }, env)).status).toBe(401)
    expect(await kv.get('revoked_user:guest')).toBe('1')
  })

  test('an unknown address 404s', async () => {
    const { app, db, kv, env } = makeRouteApp()
    await mintUser(db, kv, 'admin', { role: 'superadmin' })
    const res = await app.request(
      '/api/admin/invites/nobody%40example.com',
      { method: 'DELETE', headers: auth('admin') },
      env,
    )
    expect(res.status).toBe(404)
  })
})
