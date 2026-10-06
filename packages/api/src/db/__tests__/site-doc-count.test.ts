import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { makeDb, seedSite, seedSpace, seedUser } from '../../test/harness'
import { documents, sites } from '../schema'

describe('site document count migration', () => {
  test('backfills existing sites and maintains counts through inserts, updates, and site deletion', async () => {
    const db = makeDb()
    const ownerId = await seedUser(db)
    const spaceId = await seedSpace(db, { createdBy: ownerId })
    const siteId = await seedSite(db, { spaceId, ownerId })
    const emptyId = await seedSite(db, { spaceId, ownerId })
    const row = {
      siteId,
      collection: 'notes',
      docId: 'old',
      json: {},
      createdBy: ownerId,
      createdAt: 'now',
      updatedAt: 'now',
    }
    await db.insert(documents).values(row)

    // Recreate the pre-migration schema with existing data, then apply the shipped SQL.
    await db.run(sql`DROP TRIGGER documents_doc_count_insert`)
    await db.run(sql`DROP TRIGGER documents_doc_count_delete`)
    await db.run(sql`ALTER TABLE sites DROP COLUMN docCount`)
    const migration = readFileSync(new URL('../../../drizzle/0035_site_doc_count.sql', import.meta.url), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) await db.run(sql.raw(statement))
    const count = async (id: string) =>
      (await db.select({ count: sites.docCount }).from(sites).where(eq(sites.id, id)))[0]?.count
    expect(await count(siteId)).toBe(1)
    expect(await count(emptyId)).toBe(0)
    await db.insert(documents).values({ ...row, docId: 'new' })
    expect(await count(siteId)).toBe(2)
    await db
      .update(documents)
      .set({ json: { edited: true } })
      .where(eq(documents.siteId, siteId))
    expect(await count(siteId)).toBe(2)
    await db.delete(sites).where(eq(sites.id, siteId))
    expect(await db.$count(documents)).toBe(0)
    expect(await count(emptyId)).toBe(0)
  })
})
