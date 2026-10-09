import { describe, expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { validKvKey } from '../../../../shared/kv'
import { signDataToken } from '../../lib/data-token'
import { KV_PERSONAL_QUOTA, KV_SHARED_QUOTA, KV_SITE_KEYS } from '../../lib/site-kv'
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
  test('personal keys are per viewer', async () => {
    const { call, alice, bob } = await scenario()
    expect((await call(alice, 'PUT', '/personal/theme', 'dark')).body).toEqual({
      key: 'theme',
      value: 'dark',
      shared: false,
    })
    expect((await call(alice, 'GET', '/personal/theme')).body).toEqual({ key: 'theme', value: 'dark', shared: false })
    expect((await call(bob, 'GET', '/personal/theme')).status).toBe(404)
  })

  test('shared keys are visible to every viewer and separate from personal ones', async () => {
    const { call, alice, bob } = await scenario()
    await call(alice, 'PUT', '/shared/votes', '3')
    await call(bob, 'PUT', '/personal/votes', 'mine')
    expect((await call(bob, 'GET', '/shared/votes')).body).toEqual({ key: 'votes', value: '3', shared: true })
    expect((await call(bob, 'PUT', '/shared/votes', '4')).status).toBe(200)
    expect((await call(alice, 'GET', '/shared/votes')).body?.value).toBe('4')
    expect((await call(alice, 'GET', '/personal/votes')).status).toBe(404)
  })

  test('list filters by prefix (LIKE wildcards are literal), delete removes', async () => {
    const { call, alice } = await scenario()
    for (const k of ['todo:1', 'todo:2', 'todo%x', 'note'])
      await call(alice, 'PUT', `/personal/${encodeURIComponent(k)}`, 'v')
    expect((await call(alice, 'GET', '/personal?prefix=todo:')).body).toEqual({ keys: ['todo:1', 'todo:2'] })
    expect((await call(alice, 'GET', `/personal?prefix=${encodeURIComponent('todo%')}`)).body).toEqual({
      keys: ['todo%x'],
    })
    expect((await call(alice, 'DELETE', '/personal/note')).body).toEqual({ key: 'note', deleted: true, shared: false })
    expect((await call(alice, 'GET', '/personal')).body?.keys).toEqual(['todo%x', 'todo:1', 'todo:2'])
  })

  test('keys and values are limited, and values are measured in UTF-8 bytes', async () => {
    const { call, alice } = await scenario()
    expect((await call(alice, 'PUT', `/personal/${'k'.repeat(201)}`, 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/personal/has%20space', 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/personal/a%2Fb', 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/personal/ok', 'x'.repeat(1_000_001))).status).toBe(413)
    // 400k CJK characters are 1.2 MB in UTF-8: over the limit though well under a million characters.
    expect((await call(alice, 'PUT', '/personal/cjk', '字'.repeat(400_000))).status).toBe(413)
  })

  test("personal keys stop at the per-viewer quota without touching anyone else's room", async () => {
    const { call, alice, bob } = await scenario()
    const chunk = 'x'.repeat(990_000)
    let i = 0
    while ((await call(alice, 'PUT', `/personal/c${i}`, chunk)).status === 200) i++
    expect(i).toBe(Math.floor(KV_PERSONAL_QUOTA / (chunk.length + 3)))
    expect((await call(bob, 'PUT', '/personal/mine', 'still fine')).status).toBe(200)
    expect((await call(bob, 'PUT', '/shared/also', 'fine')).status).toBe(200)
  })

  test("shared keys have their own pool, so filling it can't starve personal keys", async () => {
    const { call, alice, bob } = await scenario()
    const chunk = 'x'.repeat(990_000)
    let i = 0
    while ((await call(alice, 'PUT', `/shared/c${i}`, chunk)).status === 200) i++
    expect(i).toBe(Math.floor(KV_SHARED_QUOTA / (chunk.length + 3)))
    expect((await call(bob, 'PUT', '/personal/mine', chunk)).status).toBe(200)
    // Overwriting only counts the new size.
    expect((await call(alice, 'PUT', '/shared/c0', 'small')).status).toBe(200)
    expect((await call(alice, 'PUT', `/shared/c${i}`, chunk)).status).toBe(200)
  })

  test('a site holds a bounded number of keys; existing ones can still be updated', async () => {
    const { db, call, alice } = await scenario()
    await db.run(sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${KV_SITE_KEYS})
      INSERT INTO site_kv (siteId, ownerId, key, value, bytes, updatedAt) SELECT 'site1', '', 'k' || i, 'v', 3, '' FROM n`)
    expect((await call(alice, 'PUT', '/shared/one-more', 'v')).status).toBe(413)
    expect((await call(alice, 'PUT', '/shared/k1', 'updated')).status).toBe(200)
    expect((await call(alice, 'GET', '/shared?prefix=k')).body?.keys).toHaveLength(1000)
  })

  test('the site counters follow inserts, updates and deletes', async () => {
    const { db, call, alice } = await scenario()
    const totals = async () =>
      (
        await db.all<{ kvBytes: number; kvCount: number }>(sql`SELECT kvBytes, kvCount FROM sites WHERE id = 'site1'`)
      )[0]
    await call(alice, 'PUT', '/personal/k', 'abc')
    expect(await totals()).toEqual({ kvBytes: 4, kvCount: 1 })
    await call(alice, 'PUT', '/personal/k', 'abcdef')
    expect(await totals()).toEqual({ kvBytes: 7, kvCount: 1 })
    await call(alice, 'DELETE', '/personal/k')
    expect(await totals()).toEqual({ kvBytes: 0, kvCount: 0 })
  })

  test('a deleted user takes their personal keys with them', async () => {
    const { db, call, alice } = await scenario()
    await call(alice, 'PUT', '/personal/k', 'v')
    await call(alice, 'PUT', '/shared/k', 'v')
    await db.run(sql`DELETE FROM users WHERE id = 'alice'`)
    const left = await db.all<{ ownerId: string }>(sql`SELECT ownerId FROM site_kv`)
    expect(left).toEqual([{ ownerId: '' }])
  })

  test('writing needs the create capability; a read-only token can only read', async () => {
    const { call, alice, readOnly } = await scenario()
    await call(alice, 'PUT', '/shared/k', 'v')
    expect((await call(readOnly, 'GET', '/shared/k')).status).toBe(200)
    expect((await call(readOnly, 'PUT', '/shared/k', 'x')).status).toBe(403)
    expect((await call(readOnly, 'DELETE', '/shared/k')).status).toBe(403)
  })

  test('/_kv is terminal: nothing under it reaches the document routes', async () => {
    const { call, alice } = await scenario()
    expect((await call(alice, 'PUT', '/shared', 'v')).status).toBe(404)
    expect((await call(alice, 'DELETE', '/personal')).status).toBe(404)
    expect((await call(alice, 'POST', '', 'v')).status).toBe(404)
    expect((await call(alice, 'PUT', '/team/k', 'v')).status).toBe(404)
  })

  test('dot keys are refused, and HEAD reads like GET', async () => {
    const { call, alice } = await scenario()
    for (const key of ['.', '..', 'tab\there', 'nul\u0000']) expect(validKvKey(key)).toBe(false)
    // An encoded dot segment never even reaches the key route: URL parsing collapses it.
    expect((await call(alice, 'PUT', '/personal/%2E%2E', 'v')).status).toBeGreaterThanOrEqual(400)
    await call(alice, 'PUT', '/personal/k', 'v')
    expect((await call(alice, 'HEAD', '/personal/k')).status).toBe(200)
  })
})
