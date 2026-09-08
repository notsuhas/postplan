import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { files, siteVersionFiles, siteVersions, sites } from '../../db/schema'
import { seedFile, seedMember, seedSite, seedSpace } from '../../test/harness'
import { authHeaders, makeRouteApp, mintUser } from '../../test/route-fixtures'

async function setup() {
  const route = makeRouteApp()
  const owner = await mintUser(route.db, route.kv, 'owner')
  const space = await seedSpace(route.db, { id: 'space', slug: 'acme', createdBy: owner })
  await seedMember(route.db, space, owner)
  const site = await seedSite(route.db, { id: 'site', spaceId: space, ownerId: owner, slug: 'demo' })
  await route.db.update(sites).set({ contentVersion: 1 }).where(eq(sites.id, site))
  await seedFile(route.db, route.r2, site, {
    id: 'current',
    path: 'index.html',
    storageKey: 'v1/index.html',
    text: 'one',
  })
  await route.r2.put('v0/index.html', 'zero')
  await route.db.insert(siteVersions).values([
    { id: 'site:v0', siteId: site, version: 0, createdBy: owner, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'site:v1', siteId: site, version: 1, createdBy: owner, createdAt: '2026-01-02T00:00:00.000Z' },
  ])
  await route.db.insert(siteVersionFiles).values([
    { id: 'vf0', versionId: 'site:v0', path: 'index.html', storageKey: 'v0/index.html', size: 4, etag: 'zero' },
    { id: 'vf1', versionId: 'site:v1', path: 'index.html', storageKey: 'v1/index.html', size: 3, etag: 'one' },
  ])
  return route
}

describe('site versions', () => {
  test('lists snapshots newest first and marks the head', async () => {
    const { app, env } = await setup()
    const res = await app.request('/api/sites/acme/demo/versions', { headers: authHeaders('owner') }, env)
    expect(res.status).toBe(200)
    const rows = (await res.json()) as { version: number; current: boolean; files: { path: string }[] }[]
    expect(rows.map(({ version }) => version)).toEqual([1, 0])
    expect(rows[0]).toMatchObject({ current: true, files: [{ path: 'index.html' }] })
  })

  test('rollback restores files as a new head and keeps every snapshot', async () => {
    const { app, env, db } = await setup()
    const res = await app.request(
      '/api/sites/acme/demo/versions/0/rollback',
      {
        method: 'POST',
        headers: authHeaders('owner'),
        body: JSON.stringify({ expectedVersion: 1 }),
      },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ version: 2, restoredFrom: 0 })
    expect((await db.select().from(sites).where(eq(sites.id, 'site')))[0].contentVersion).toBe(2)
    expect((await db.select().from(files).where(eq(files.siteId, 'site')))[0].storageKey).toBe('v0/index.html')
    expect(await db.select().from(siteVersions).where(eq(siteVersions.siteId, 'site'))).toHaveLength(3)
  })

  test('stale rollback is rejected before changing files', async () => {
    const { app, env, db } = await setup()
    const res = await app.request(
      '/api/sites/acme/demo/versions/0/rollback',
      {
        method: 'POST',
        headers: authHeaders('owner'),
        body: JSON.stringify({ expectedVersion: 0 }),
      },
      env,
    )
    expect(res.status).toBe(409)
    expect((await db.select().from(files).where(eq(files.siteId, 'site')))[0].storageKey).toBe('v1/index.html')
  })

  test('site deletion reclaims current and historical objects', async () => {
    const { app, env, r2 } = await setup()
    const res = await app.request('/api/sites/acme/demo', { method: 'DELETE', headers: authHeaders('owner') }, env)
    expect(res.status).toBe(200)
    expect(r2.store.size).toBe(0)
  })
})
