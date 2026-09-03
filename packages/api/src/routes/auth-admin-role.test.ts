import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { makeDb } from '../test/harness'
import type { AppEnv } from '../types'
import { findOrCreateUser } from './auth'

// SUPERADMIN_EMAIL is the address the bootstrap token claims; ADMIN_EMAILS adds the rest. Both
// grant `superadmin`, and the grant is re-applied on every login — otherwise adding an address to
// ADMIN_EMAILS would silently do nothing for someone who already signed in as a member.

const env = {
  SUPERADMIN_EMAIL: 'boss@example.com',
  ADMIN_EMAILS: 'second@other.com, third@other.com',
} as AppEnv['Bindings']

const claims = (sub: string, email: string) =>
  ({ sub, email, email_verified: true, name: 'X' }) as never

const roleOf = async (db: ReturnType<typeof makeDb>, id: string) =>
  (await db.select().from(users).where(eq(users.id, id)))[0]?.role

describe('findOrCreateUser — who becomes a superadmin', () => {
  test('SUPERADMIN_EMAIL is a superadmin on first login', async () => {
    const db = makeDb()
    const u = await findOrCreateUser(db, env, claims('g-1', 'boss@example.com'), 'boss@example.com')
    expect(u.role).toBe('superadmin')
    expect(await roleOf(db, u.id)).toBe('superadmin')
  })

  test('an ADMIN_EMAILS entry is too — including one listed after a comma and a space', async () => {
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

    const promoted = { ...env, ADMIN_EMAILS: 'later@other.com' } as AppEnv['Bindings']
    const after = await findOrCreateUser(db, promoted, claims('g-4', 'later@other.com'), 'later@other.com')
    expect(after.role).toBe('superadmin')
    expect(await roleOf(db, before.id)).toBe('superadmin')
  })

  // Promote-only: a fat-fingered ADMIN_EMAILS edit must not strip the last superadmin out of its
  // own instance. Demotion is a deliberate act in the admin UI.
  test('dropping an address never demotes', async () => {
    const db = makeDb()
    const u = await findOrCreateUser(db, env, claims('g-5', 'second@other.com'), 'second@other.com')
    expect(u.role).toBe('superadmin')

    const dropped = { ...env, ADMIN_EMAILS: '' } as AppEnv['Bindings']
    const after = await findOrCreateUser(db, dropped, claims('g-5', 'second@other.com'), 'second@other.com')
    expect(after.role).toBe('superadmin')
  })
})
