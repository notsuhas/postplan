import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { sites } from '../db/schema'
import { seedMember, seedSite, seedSpace } from '../test/harness'
import { auth, makeRouteApp, mintUser } from '../test/route-fixtures'

describe('PATCH /api/sites visibility', () => {
  test('rotates a guessable slug when a site becomes unlisted', async () => {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'owner')
    const spaceId = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, spaceId, 'owner')
    const siteId = await seedSite(db, { spaceId, ownerId: 'owner', slug: 'report', visibility: 'private' })

    const response = await app.request(
      '/api/sites/docs/report',
      { method: 'PATCH', headers: auth('owner'), body: JSON.stringify({ visibility: 'unlisted' }) },
      env,
    )
    const body = (await response.json()) as { siteSlug: string; url: string }
    expect(response.status).toBe(200)
    expect(body.siteSlug).toMatch(/^report-[0-9a-f]{32}$/)
    expect(body.url).toBe(`${env.APP_URL}/docs/${body.siteSlug}`)
    expect((await db.select().from(sites).where(eq(sites.id, siteId)))[0]).toMatchObject({
      slug: body.siteSlug,
      visibility: 'unlisted',
    })
  })

  test('does not rotate an already-unlisted site on unrelated updates', async () => {
    const { app, env, db, kv } = makeRouteApp()
    await mintUser(db, kv, 'owner')
    const spaceId = await seedSpace(db, { createdBy: 'owner', slug: 'docs' })
    await seedMember(db, spaceId, 'owner')
    await seedSite(db, { spaceId, ownerId: 'owner', slug: 'report-secret', visibility: 'unlisted' })

    const response = await app.request(
      '/api/sites/docs/report-secret',
      { method: 'PATCH', headers: auth('owner'), body: JSON.stringify({ title: 'New title' }) },
      env,
    )
    expect(await response.json()).toMatchObject({ siteSlug: 'report-secret' })
  })
})
