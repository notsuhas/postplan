import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { signDataToken } from '../../lib/data-token'
import { KV_SITE_QUOTA } from '../../lib/site-kv'
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
  return { call, alice: await viewer('alice'), bob: await viewer('bob'), readOnly: await viewer('bob', ['read']) }
}

describe('window.storage backend', () => {
  test('personal keys are per viewer', async () => {
    const { call, alice, bob } = await scenario()
    expect((await call(alice, 'PUT', '/personal/theme', 'dark')).body).toEqual({ key: 'theme', value: 'dark' })
    expect((await call(alice, 'GET', '/personal/theme')).body).toEqual({ key: 'theme', value: 'dark' })
    expect((await call(bob, 'GET', '/personal/theme')).status).toBe(404)
  })

  test('shared keys are visible to every viewer and separate from personal ones', async () => {
    const { call, alice, bob } = await scenario()
    await call(alice, 'PUT', '/shared/votes', '3')
    await call(bob, 'PUT', '/personal/votes', 'mine')
    expect((await call(bob, 'GET', '/shared/votes')).body).toEqual({ key: 'votes', value: '3' })
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
    expect((await call(alice, 'DELETE', '/personal/note')).body).toEqual({ key: 'note', deleted: true })
    expect((await call(alice, 'GET', '/personal')).body?.keys).toEqual(['todo%x', 'todo:1', 'todo:2'])
  })

  test('keys, values and the site quota are enforced', async () => {
    const { call, alice } = await scenario()
    expect((await call(alice, 'PUT', `/personal/${'k'.repeat(201)}`, 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/personal/has%20space', 'v')).status).toBe(400)
    expect((await call(alice, 'PUT', '/personal/ok', 'x'.repeat(1_000_001))).status).toBe(413)
    const chunk = 'x'.repeat(999_000)
    let i = 0
    while ((await call(alice, 'PUT', `/shared/c${i}`, chunk)).status === 200) i++
    expect(i).toBe(Math.floor(KV_SITE_QUOTA / (chunk.length + 3)))
    expect((await call(alice, 'PUT', `/shared/c${i}`, chunk)).status).toBe(413)
  })

  test('writing needs the create capability; a read-only token can only read', async () => {
    const { call, alice, readOnly } = await scenario()
    await call(alice, 'PUT', '/shared/k', 'v')
    expect((await call(readOnly, 'GET', '/shared/k')).status).toBe(200)
    expect((await call(readOnly, 'PUT', '/shared/k', 'x')).status).toBe(403)
    expect((await call(readOnly, 'DELETE', '/shared/k')).status).toBe(403)
  })

  test('an unknown scope is not a route, and a document named _kv still needs write', async () => {
    const { call, alice } = await scenario()
    expect((await call(alice, 'PUT', '/team/k', 'v')).status).toBe(403)
    expect((await call(alice, 'GET', '/team/k')).status).toBe(404)
  })
})
