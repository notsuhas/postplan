import type { Site } from '../db/schema'
import type { SessionUser } from '../types'

export type AccessResult = { ok: true } | { ok: false; status: 401 | 403 | 410 }

const ALLOW: AccessResult = { ok: true }

/**
 * Pure permission logic — the single source of truth for visibility, used by both
 * the API and the content worker. `isMember` (space membership for `members` sites)
 * is resolved by the caller via DB lookup so this stays pure and unit-testable.
 *
 *   unlisted→ anyone holding the URL (no login); the unguessable slug IS the credential
 *   private → owner only
 *   members → space member (or owner)
 *   team    → any authenticated user in the allowed domain
 *   shared  → any user/group explicitly granted access (additive, any tier)
 *   archived→ 410 for everyone
 *
 * `unlisted` is the ONLY anonymous tier. It is never listed on any surface (dashboard, search,
 * feed, sitemap) — reaching it requires the exact URL, whose slug carries a random suffix for
 * precisely this reason (see lib/slug). Every other tier still requires an authenticated user.
 *
 * ROLE IS DELIBERATELY NOT CONSULTED. A superadmin reads a site only by the same tiers as
 * anyone else: their custodial powers (see every site's metadata, archive/restore, delete) are
 * the admin routes, and STOP at the content. Do not reintroduce a role bypass here — every read
 * surface (content worker, search, stars, spaces, comment feed, notifications) funnels through
 * this function, so one bypass line hands back the whole corpus.
 */
export function checkAccess(
  site: Pick<Site, 'visibility' | 'status' | 'ownerId'>,
  user: Pick<SessionUser, 'id' | 'role' | 'isOrgMember'> | null,
  isMember: boolean,
  isShared = false,
): AccessResult {
  if (site.status === 'archived') return { ok: false, status: 410 }
  if (user?.id === site.ownerId) return ALLOW
  // Explicit per-user / per-group grant — additive on top of the visibility tier.
  if (isShared && user) return ALLOW

  switch (site.visibility) {
    // No user needed: possession of the URL is the grant. Deliberately above the `user` checks so
    // an anonymous reader is allowed, not 401'd.
    case 'unlisted':
      return ALLOW
    case 'team':
      if (!user) return { ok: false, status: 401 }
      return user.isOrgMember ? ALLOW : { ok: false, status: 403 }
    case 'members':
      if (!user) return { ok: false, status: 401 }
      return isMember || site.ownerId === user.id ? ALLOW : { ok: false, status: 403 }
    case 'private':
      if (!user) return { ok: false, status: 401 }
      return site.ownerId === user.id ? ALLOW : { ok: false, status: 403 }
    default:
      return { ok: false, status: 403 }
  }
}

export function canDiscover(
  site: Pick<Site, 'visibility' | 'status' | 'ownerId'>,
  user: Pick<SessionUser, 'id' | 'role' | 'isOrgMember'>,
  isMember: boolean,
  isShared = false,
): boolean {
  if (site.status === 'archived') return false
  if (site.ownerId === user.id || isShared) return true
  if (site.visibility === 'unlisted') return false
  return checkAccess(site, user, isMember, false).ok
}

/**
 * Whether a user may CONTENT-REPLACE (redeploy) a site — a strictly narrower capability than
 * `checkAccess` (which is read/view). Owner always; a direct EDITOR share otherwise (a plain
 * viewer / group share / tier-only reacher may NOT). `shareRole` is the caller's DIRECT
 * share role (`resolveShareRole`), null when they have none. Single source of truth for the upload
 * gate, `/exists` canReplace, and the meta-route manifest gate — do NOT re-inline the predicate.
 *
 * Role is not consulted (same rule as `checkAccess`): the manifest this gates lists the site's
 * files, and replace lets the actor plant content the owner will open — neither is a custodial
 * power, so a superadmin gets them only by owning the site or holding an editor share.
 */
export function canReplace(
  user: Pick<SessionUser, 'id'>,
  site: Pick<Site, 'ownerId'>,
  shareRole: 'viewer' | 'editor' | null,
): boolean {
  return site.ownerId === user.id || shareRole === 'editor'
}
