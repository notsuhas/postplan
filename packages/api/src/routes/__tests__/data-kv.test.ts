import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { validKvKey } from '../../../../shared/kv'
import { signDataToken } from '../../lib/data-token'
import { KV_QUOTA } from '../../lib/site-kv'
import { type HarnessDb, makeDb, seedMember, seedSite, seedSpace, seedUser } from '../../test/harness'
import { dataApi } from '../data'

const HMAC = 'postplan-test-kv'
const ENV = { DATA_TOKEN_SECRET: HMAC, CONTENT_URL: 'https://content.example.com' } as never

async function scenario() {
  const db = makeDb()
  for (const id of ['owner', 'alice', 'bob']) await seedUser(db, { id, email: `${id}@example.com` })
  const sp = await seedSpace(db, { id: 'sp1', slug: 'sam', createdBy: 'owner' })
  for (const id of ['owner', 'alice', 'bob']) await seedMember(db, sp, id)
  await seedSite(db, { id: 'site1', spaceId: sp, ownerId: 'owner', slug: 'demo', visibility: 'members' })
  const app = new Hono<{ Variables: { db: HarnessDb } }>()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/api/_data', dataApi)
  const viewer = (id: string, caps: ('read' | 'create')[] = ['read', 'create']) =>
    signDataToken(HMAC, { siteId: 'site1', viewerId: id, caps })
  const call = async (token: string, method: string, path: string, value?: string) => {
    const res = await app.request(
      `/api/_data/_kv${path}`,
      {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: value === undefined ? undefined : JSON.stringify({ value }),
      },
      ENV,
    )
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
  }
  return {
    db,
    call,
    alice: await viewer('alice'),
    bob: await viewer('bob'),
    readOnly: await viewer('bob', ['read']),
  }
}

describe('window.storage backend', () => {
  test('keys are private to each viewer', async () => {
    const { call, alice, bob } = await scenario()
    expect((await call(alice, 'PUT', '/theme', 'dark')).body).toEqual({
      key: 'theme',
      value: 'dark',
      shared: false,
    })
    expect((await call(alice, 'GET', '/theme')).body).toEqual({ key: 'theme', value: 'dark', shared: false })
    expect((await call(bob, 'GET', '/theme')).status).toBe(404)
  })

  test('list filters by prefix (LIKE wildcards are literal), delete removes', async () => {
    const { call, alice } = await scenario()
    for (const k of ['todo:1', 'todo:2', 'todo%x', 'note']) await call(alice, 'PUT', `/${encodeURIComponent(k)}`, 'v')
    expect((await call(alice, 'GET', '?prefix=todo:')).body).toEqual({ keys: ['todo:1', 'todo:2'] })
    expect((await call(alice, 'GET', `?prefix=${encodeURIComponent('todo%')}`)).body).toEqual({
      keys: ['todo%x'],
    })
    expect((await call(alice, 'DELETE', '/note')).body).toEqual({ key: 'note', deleted: true, shared: false })
    expect((await call(alice, 'GET', '')).body?.keys).toEqual(['todo%x', 'todo:1', 'todo:2'])
  })

  test('keys and values are limited, and values are measured in UTF-8 bytes', async () => {
    const { call, alice } = await scenario()
    expect((await call(alice, 'PUT', `/${'k'.repeat(201)}`, 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/has%20space', 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/a%2Fb', 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/a%F4%8F%BF%BF', 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/ok', 'x'.repeat(1_000_001))).status).toBe(413)
    // 400k CJK characters are 1.2 MB in UTF-8: over the limit though well under a million characters.
    expect((await call(alice, 'PUT', '/cjk', '字'.repeat(400_000))).status).toBe(413)
  })

  test("keys stop at the per-viewer quota without touching anyone else's room", async () => {
    const { call, alice, bob } = await scenario()
    const chunk = 'x'.repeat(990_000)
    let i = 0
    while ((await call(alice, 'PUT', `/c${i}`, chunk)).status === 200) i++
    expect(i).toBe(Math.floor(KV_QUOTA.bytes / (chunk.length + 3)))
    expect((await call(bob, 'PUT', '/mine', 'still fine')).status).toBe(200)
  })

  test('a viewer holds a bounded number of keys; a full viewer locks out no one else', async () => {
    const { db, call, alice, bob } = await scenario()
    await db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${KV_QUOTA.keys})
      INSERT INTO site_kv (siteId, userId, key, value, bytes, updatedAt) SELECT 'site1', 'alice', 'k' || i, 'v', 3, '' FROM n`)
    expect((await call(alice, 'PUT', '/one-more', 'v')).status).toBe(413)
    expect((await call(alice, 'PUT', '/k1', 'updated')).status).toBe(200)
    expect((await call(alice, 'GET', '?prefix=k')).body?.keys).toHaveLength(1000)
    expect((await call(bob, 'PUT', '/mine', 'v')).status).toBe(200)
  })

  test('list is a case-sensitive prefix match and rejects oversized prefixes', async () => {
    const { call, alice } = await scenario()
    for (const k of ['Todo1', 'todo2', 'todo_3', 'todx']) await call(alice, 'PUT', `/${k}`, 'v')
    expect((await call(alice, 'GET', '?prefix=todo')).body?.keys).toEqual(['todo2', 'todo_3'])
    expect((await call(alice, 'GET', '?prefix=todo_')).body?.keys).toEqual(['todo_3'])
    expect((await call(alice, 'GET', `?prefix=${'x'.repeat(201)}`)).status).toBe(400)
  })

  test('a deleted user takes their keys with them', async () => {
    const { db, call, alice, bob } = await scenario()
    await call(alice, 'PUT', '/k', 'v')
    await call(bob, 'PUT', '/k', 'v')
    await db.run(sql`DELETE FROM users WHERE id = 'alice'`)
    expect(await db.all<{ userId: string }>(sql`SELECT userId FROM site_kv`)).toEqual([{ userId: 'bob' }])
  })

  test('writing needs the create capability; a read-only token can only read', async () => {
    const { call, bob, readOnly } = await scenario()
    await call(bob, 'PUT', '/k', 'v')
    expect((await call(readOnly, 'GET', '/k')).status).toBe(200)
    expect((await call(readOnly, 'PUT', '/k', 'x')).status).toBe(403)
    expect((await call(readOnly, 'DELETE', '/k')).status).toBe(403)
  })

  test('/_kv is terminal: nothing under it reaches the document routes', async () => {
    const { call, alice } = await scenario()
    expect((await call(alice, 'PUT', '', 'v')).status).toBe(404)
    expect((await call(alice, 'DELETE', '')).status).toBe(404)
    expect((await call(alice, 'POST', '', 'v')).status).toBe(403)
    expect((await call(alice, 'PUT', '/shared/k', 'v')).status).toBe(404)
  })

  test('dot keys are refused, and HEAD reads like GET', async () => {
    const { call, alice } = await scenario()
    for (const key of ['.', '..', 'tab\there', 'nul\u0000']) expect(validKvKey(key)).toBe(false)
    // An encoded dot segment never even reaches the key route: URL parsing collapses it.
    expect((await call(alice, 'PUT', '/%2E%2E', 'v')).status).toBeGreaterThanOrEqual(400)
    await call(alice, 'PUT', '/k', 'v')
    expect((await call(alice, 'HEAD', '/k')).status).toBe(200)
  })
})
