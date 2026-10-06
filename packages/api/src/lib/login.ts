import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { createPersonalSpace, toSessionUser } from '../db/repo'
import { NEWEST_RELEASE_DATE } from '../whats-new/catalog'
import { isAdminEmail, isOrgEmail } from './access-policy'
import { sanitizeAvatarUrl } from './avatar'
import type { IdpClaims } from './auth-provider'
import type { AppEnv, Bindings, SessionUser } from '../types'

// Matches by provider subject then verified email, so switching providers backfills
// onto the existing local user. Role is preserved unless the address is
// in the admin allowlist, which promotes; nothing here ever demotes. The googleId column keeps its
// name for compatibility: WorkOS subjects are unchanged; other providers are namespaced.
export async function findOrCreateUser(
  db: AppEnv['Variables']['db'],
  env: Bindings,
  claims: IdpClaims,
  email: string,
): Promise<SessionUser> {
  const byGoogle = await db.select().from(users).where(eq(users.googleId, claims.sub)).limit(1)
  const existing = byGoogle[0] ?? (await db.select().from(users).where(eq(users.email, email)).limit(1))[0]

  // The photo is re-read from the IdP on EVERY login, which is also the only backfill it
  // offers: users who signed up before avatars existed get one the next time they sign in. A claim
  // that fails the host pin leaves the stored URL untouched rather than clearing a good one.
  const avatarUrl = sanitizeAvatarUrl(claims.picture)

  // Promote on EVERY login, not just at creation: adding an address to SUPERADMIN_EMAILS has to reach
  // someone who already signed in as a member, or the var silently does nothing for them.
  // Promote-only — removing an address never demotes, so a fat-fingered edit cannot strip the last
  // superadmin out of its own instance. Demote through the admin UI, deliberately.
  const admin = isAdminEmail(env, email)
  const isOrgMember = isOrgEmail(env, email)

  if (existing) {
    const name = claims.name ?? existing.name
    const role = admin ? 'superadmin' : existing.role
    await db
      .update(users)
      .set({
        name,
        googleId: claims.sub,
        avatarUrl: avatarUrl ?? existing.avatarUrl,
        role,
        isOrgMember,
        disabledAt: null,
      })
      .where(eq(users.id, existing.id))
    await createPersonalSpace(db, existing.id, email)
    return toSessionUser({ ...existing, name, role, isOrgMember })
  }

  const id = crypto.randomUUID()
  const role = admin ? 'superadmin' : 'member'
  // New signups start caught up on release notes (watermark = newest), so they don't land on an
  // inbox full of "unread" features that shipped before they existed. null would mean all-unread.
  await db.insert(users).values({
    id,
    email,
    name: claims.name ?? null,
    googleId: claims.sub,
    avatarUrl,
    role,
    isOrgMember,
    lastSeenReleaseAt: NEWEST_RELEASE_DATE,
  })
  await createPersonalSpace(db, id, email)
  return { id, email, name: claims.name ?? null, role, isOrgMember }
}
