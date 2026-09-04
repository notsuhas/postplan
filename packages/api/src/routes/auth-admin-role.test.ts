import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { makeDb } from '../test/harness'
import type { AppEnv } from '../types'
import { findOrCreateUser } from './auth'

// SUPERADMIN_EMAIL is the address the bootstrap token claims; SUPERADMIN_EMAILS adds the rest.
// Both grant `superadmin`, and the grant is re-applied on every login — otherwise adding an address
// would silently do nothing for someone who had already signed in as a member.

const env = {
  SUPERADMIN_EMAIL: 'boss@example.com',
  SUPERADMIN_EMAILS: 'second@other.com, third@other.com',
} as AppEnv['Bindings']

const claims = (sub: string, email: string) => ({ sub, email, email_verified: true, name: 'X' }) as never

const roleOf = async (db: ReturnType<typeof makeDb>, id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]?.role

describe('findOrCreateUser — who becomes a superadmin', () => {
  test('SUPERADMIN_EMAIL is a superadmin on first login', async () => {
    const db = makeDb()
    const u = await findOrCreateUser(db, env, claims('g-1', 'boss@example.com'), 'boss@example.com')
    expect(u.role).toBe('superadmin')
    expect(await roleOf(db, u.id)).toBe('superadmin')
  })

  test('a SUPERADMIN_EMAILS entry is too — including one listed after a comma and a space', async () => {
    const db = makeDb()
    const u = await findOrCreateUser(db, env, claims('g-2', 'third@other.com'), 'third@other.com')
    expect(u.role).toBe('superadmin')
  })

  test('anyone else is a member', async () => {
    const db = makeDb()
    const u = await findOrCreateUser(db, env, claims('g-3', 'nobody@other.com'), 'nobody@other.com')
    expect(u.role).toBe('member')
  })

  // The reason the grant is not creation-only.
  test('a member already in the table is promoted once their address is listed', async () => {
    const db = makeDb()
    const before = await findOrCreateUser(db, env, claims('g-4', 'later@other.com'), 'later@other.com')
    expect(before.role).toBe('member')

    const promoted = { ...env, SUPERADMIN_EMAILS: 'later@other.com' } as AppEnv['Bindings']
    const after = await findOrCreateUser(db, promoted, claims('g-4', 'later@other.com'), 'later@other.com')
    expect(after.role).toBe('superadmin')
    expect(await roleOf(db, before.id)).toBe('superadmin')
  })

  // Promote-only: a fat-fingered SUPERADMIN_EMAILS edit must not strip the last superadmin out of its
  // own instance. Demotion is a deliberate act in the admin UI.
  test('dropping an address never demotes', async () => {
    const db = makeDb()
    const u = await findOrCreateUser(db, env, claims('g-5', 'second@other.com'), 'second@other.com')
    expect(u.role).toBe('superadmin')

    const dropped = { ...env, SUPERADMIN_EMAILS: '' } as AppEnv['Bindings']
    const after = await findOrCreateUser(db, dropped, claims('g-5', 'second@other.com'), 'second@other.com')
    expect(after.role).toBe('superadmin')
  })
  // The old spelling stays readable so an existing deploy keeps working without a config edit.
  // Delete this test only when the fallback in lib/workos.ts goes too.
  test('the deprecated ADMIN_EMAILS spelling still grants superadmin', async () => {
    const db = makeDb()
    const legacy = { SUPERADMIN_EMAIL: 'boss@example.com', ADMIN_EMAILS: 'old@other.com' } as AppEnv['Bindings']
    const u = await findOrCreateUser(db, legacy, claims('g-6', 'old@other.com'), 'old@other.com')
    expect(u.role).toBe('superadmin')
  })

  // SUPERADMIN_EMAILS wins when both are set, so a half-finished rename cannot silently keep
  // honouring a stale list.
  test('SUPERADMIN_EMAILS takes precedence over the deprecated spelling', async () => {
    const db = makeDb()
    const both = {
      SUPERADMIN_EMAIL: 'boss@example.com',
      SUPERADMIN_EMAILS: 'new@other.com',
      ADMIN_EMAILS: 'stale@other.com',
    } as AppEnv['Bindings']
    expect((await findOrCreateUser(db, both, claims('g-7', 'new@other.com'), 'new@other.com')).role).toBe('superadmin')
    expect((await findOrCreateUser(db, both, claims('g-8', 'stale@other.com'), 'stale@other.com')).role).toBe('member')
  })
})
