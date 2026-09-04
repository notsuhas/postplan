import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'bun:test'
import { bootstrapSuperadminByEmail } from '../db/repo'
import { users } from '../db/schema'
import { findOrCreateUser } from '../routes/auth'
import { makeDb, seedUser } from '../test/harness'
import { NEWEST_RELEASE_DATE } from './catalog'

describe('the watermark column after a fresh migrate', () => {
  // The migration-history test that used to live here applied migrations 0000..0010, inserted a
  // pre-watermark user, then applied 0011 and asserted the backfill. The 31 upstream migrations
  // have since been squashed into a single 0000_init baseline, so there is no upgrade path left in
  // this repo to exercise — a fork will never migrate a pre-0011 database. What still matters is
  // that a row written with no watermark reads back as SQL NULL rather than a default, which is
  // what the "all unread" state depends on.
  test('a user seeded with no watermark field is SQL NULL, not a default', async () => {
    const db = makeDb()
    const uid = await seedUser(db, { id: 'u-new' })
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, uid)))[0]
    expect(row.w).toBeNull()
  })
})

describe('S10 caught-up default on the insert paths (unit)', () => {
  test('findOrCreateUser stamps a new user with the newest release date', async () => {
    const db = makeDb()
    const env = { SUPERADMIN_EMAILS: 'boss@example.com' } as never
    const u = await findOrCreateUser(db, env, { sub: 'g-1', name: 'A' } as never, 'a@example.com')
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, u.id)))[0]
    expect(row.w).toBe(NEWEST_RELEASE_DATE as string)
  })

  test('bootstrapSuperadminByEmail writes the caught-up watermark the auth path passes in', async () => {
    const db = makeDb()
    const u = await bootstrapSuperadminByEmail(db, 'boss@example.com', 'Boss', NEWEST_RELEASE_DATE)
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, u.id)))[0]
    expect(row.w).toBe(NEWEST_RELEASE_DATE as string)
  })
  test('bootstrapSuperadminByEmail defaults the watermark to null (keeps repo.ts catalog-free)', async () => {
    const db = makeDb()
    const u = await bootstrapSuperadminByEmail(db, 'boss2@example.com', 'Boss2')
    const row = (await db.select({ w: users.lastSeenReleaseAt }).from(users).where(eq(users.id, u.id)))[0]
    expect(row.w).toBeNull()
  })
})
