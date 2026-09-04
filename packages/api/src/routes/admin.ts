import { and, desc, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { invites, sites, siteUserShares, spaceMembers, spaces as spacesTable, users } from '../db/schema'
import { revokeUserApiKeys } from '../lib/api-key'
import { fireAndForget } from '../lib/events'
import { revokeUserAccess, revokeUserCliTokens } from '../lib/session'
import { cachedStats } from '../lib/stats'
import { deleteSiteObjects } from '../lib/storage'
import { isVisibility, normalizeVisibility } from '../lib/visibility'
import { isAdminEmail, superadminEmails } from '../lib/workos'
import { requireAuth, requireHumanCredential, requireSuperAdmin } from '../middleware/auth'
import type { AppEnv } from '../types'

export const admin = new Hono<AppEnv>()

const PAGE_SIZE = 50

// Every admin route requires a superadmin: requireAuth first (401 if anonymous),
// then requireSuperAdmin (403 if a non-superadmin member).
admin.use('*', requireAuth, requireHumanCredential, requireSuperAdmin)

// GET /api/admin/sites — every site, newest first, with optional status/visibility filters
// and 50-per-page pagination. Joins spaces for the human-readable space slug.
admin.get('/sites', async (c) => {
  const db = c.get('db')

  const statusParam = c.req.query('status')
  const visibilityParam = c.req.query('visibility')
  const pageParam = Number.parseInt(c.req.query('page') ?? '', 10)
  const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1

  const filters = []
  if (statusParam === 'active' || statusParam === 'archived') filters.push(eq(sites.status, statusParam))
  const vis = normalizeVisibility(visibilityParam)
  if (isVisibility(vis)) filters.push(eq(sites.visibility, vis))
  const where = filters.length > 0 ? and(...filters) : undefined

  const rows = await db
    .select({
      id: sites.id,
      spaceSlug: spacesTable.slug,
      siteSlug: sites.slug,
      title: sites.title,
      visibility: sites.visibility,
      status: sites.status,
      ownerId: sites.ownerId,
      createdAt: sites.createdAt,
    })
    .from(sites)
    .innerJoin(spacesTable, eq(sites.spaceId, spacesTable.id))
    .where(where)
    .orderBy(desc(sites.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE)

  const counted = await db.select({ count: sql<number>`count(*)` }).from(sites).where(where)
  const total = Number(counted[0]?.count ?? 0)

  return c.json({ sites: rows, page, pageSize: PAGE_SIZE, total })
})

// PATCH /api/admin/sites/:id/archive — soft-archive a site. 404 if missing.
admin.patch('/sites/:id/archive', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const existing = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1)
  if (existing.length === 0) return c.json({ error: 'site not found' }, 404)
  await db.update(sites).set({ status: 'archived' }).where(eq(sites.id, id))
  return c.json({ ok: true })
})

// PATCH /api/admin/sites/:id/restore — reactivate an archived site. 404 if missing.
admin.patch('/sites/:id/restore', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const existing = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1)
  if (existing.length === 0) return c.json({ error: 'site not found' }, 404)
  await db.update(sites).set({ status: 'active' }).where(eq(sites.id, id))
  return c.json({ ok: true })
})

// DELETE /api/admin/sites/:id — hard delete. Purge R2 objects first, then the row
// (the FK cascade removes the site's file rows).
admin.delete('/sites/:id', async (c) => {
  const db = c.get('db')
  const id = c.req.param('id')
  const existing = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id)).limit(1)
  if (existing.length === 0) return c.json({ error: 'site not found' }, 404)
  await deleteSiteObjects(db, c.env.POSTPLAN_FILES, id)
  await db.delete(sites).where(eq(sites.id, id))
  return c.json({ ok: true })
})

// GET /api/admin/spaces — every space with its member count.
admin.get('/spaces', async (c) => {
  const db = c.get('db')
  const rows = await db
    .select({
      id: spacesTable.id,
      slug: spacesTable.slug,
      name: spacesTable.name,
      type: spacesTable.type,
      memberCount: sql<number>`count(${spaceMembers.userId})`,
      createdAt: spacesTable.createdAt,
    })
    .from(spacesTable)
    .leftJoin(spaceMembers, eq(spaceMembers.spaceId, spacesTable.id))
    .groupBy(spacesTable.id)
    .orderBy(desc(spacesTable.createdAt))
  return c.json(rows.map((r) => ({ ...r, memberCount: Number(r.memberCount) })))
})

// GET /api/admin/users — every user.
admin.get('/users', async (c) => {
  const db = c.get('db')
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      disabledAt: users.disabledAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(desc(users.createdAt))
  return c.json(rows)
})

// POST /api/admin/users/:id/revoke-cli — offboarding kill-switch: revoke EVERY CLI token the user
// holds (enumerated via the per-user `cli_index:` prefix) AND every D1 API key they hold — a user
// whose access is being killed keeps neither. Idempotent — a no-op for a user with no tokens/keys
// (or already-revoked ones). Superadmin-only via the router-wide requireSuperAdmin above.
admin.post('/users/:id/revoke-cli', async (c) => {
  const userId = c.req.param('id')
  await revokeUserCliTokens(c, userId)
  await revokeUserApiKeys(c.get('db'), userId)
  return c.json({ ok: true })
})

// GET /api/admin/stats — usage-analytics rollups: headline totals (users, sites, files, storage,
// comments, views, CLI invocations, unique viewers), a 30-day per-day series, and the top sites
// by views. Read-only aggregation over existing state + the events stream, served through a
// 5-minute KV entry: the rollup is full-scan-heavy and the admin page refetches it on every
// navigation, so an uncached loader dominated the account's D1 rows-read budget. The cache read
// sits BEHIND the router-wide requireSuperAdmin above — cachedStats itself is not a gate.
// --- Invites -------------------------------------------------------------------------------
// The invite gate replaced the Google-Workspace `hd` domain check when auth moved to WorkOS:
// WorkOS brokers Google for ANY account, so membership has to be an explicit allowlist. The row
// IS the invite — there is no token to send, leak or expire — so this surface is only ever
// "add an address", "see who has used theirs", "take it away".

// GET /api/admin/invites — the allowlist, plus whether each address has signed in yet. Left-joins
// users so the UI can show "invited, never signed in" apart from "signed in, here is their role".
admin.get('/invites', async (c) => {
  const db = c.get('db')
  const rows = await db
    .select({
      email: invites.email,
      invitedBy: invites.invitedBy,
      createdAt: invites.createdAt,
      usedAt: invites.usedAt,
      userId: users.id,
      role: users.role,
    })
    .from(invites)
    .leftJoin(users, eq(users.email, invites.email))
    .orderBy(desc(invites.createdAt))
  // Admins bypass the gate and may hold no invite row at all, so the UI would otherwise show an
  // empty list on a fresh instance and imply nobody can sign in.
  return c.json({ invites: rows, admins: superadminEmails(c.env) })
})

// POST /api/admin/invites — { email }. Idempotent: re-inviting an existing address is a no-op
// success rather than a 409, because the caller's intent ("this person may sign in") already holds.
admin.post('/invites', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const { email: raw } = (await c.req.json().catch(() => ({}))) as { email?: unknown }
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  // Deliberately loose: the IdP is the authority on whether an address is real, and a stricter
  // pattern here would only reject valid addresses it had not heard of.
  if (!email?.includes('@') || email.length > 320) {
    return c.json({ error: 'a valid email is required' }, 400)
  }
  if (isAdminEmail(c.env, email)) {
    return c.json({ error: 'that address is already a superadmin — it bypasses the invite gate' }, 409)
  }
  await db.insert(invites).values({ email, invitedBy: user.email, createdAt: Date.now() }).onConflictDoNothing()
  return c.json({ ok: true, email }, 201)
})

// DELETE /api/admin/invites/:email — revoke. Also kills the sessions and CLI tokens the invitee
// already holds: leaving them would mean access continues for up to the session TTL after the
// operator believes they removed it. Their sites and comments are left alone — this is a removal
// of access, not a purge, and deleting the user row would cascade their content away.
admin.delete('/invites/:email', async (c) => {
  const db = c.get('db')
  const email = c.req.param('email').trim().toLowerCase()
  const existing = (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1))[0]
  const invited = (await db.select({ email: invites.email }).from(invites).where(eq(invites.email, email)).limit(1))[0]
  if (!existing && !invited) return c.json({ error: 'not found' }, 404)

  if (existing) {
    const ownedGroup = (
      await db
        .select({ id: spacesTable.id })
        .from(spacesTable)
        .where(and(eq(spacesTable.createdBy, existing.id), eq(spacesTable.type, 'group')))
        .limit(1)
    )[0]
    if (ownedGroup) return c.json({ error: 'transfer or delete this user’s group spaces first' }, 409)

    const disabledAt = new Date().toISOString()
    await db.batch([
      db.update(users).set({ disabledAt }).where(eq(users.id, existing.id)),
      db.delete(siteUserShares).where(eq(siteUserShares.userId, existing.id)),
      db.delete(spaceMembers).where(eq(spaceMembers.userId, existing.id)),
      db.delete(invites).where(eq(invites.email, email)),
    ])
    await revokeUserAccess(c.env.POSTPLAN_SESSIONS, existing.id)
    await revokeUserCliTokens(c, existing.id)
    await revokeUserApiKeys(db, existing.id)
  } else {
    await db.delete(invites).where(eq(invites.email, email))
  }
  return c.json({ ok: true, revokedCredentials: Boolean(existing) })
})

admin.get('/stats', async (c) =>
  c.json(await cachedStats(c.env.POSTPLAN_SESSIONS, c.get('db'), (p) => fireAndForget(c, p))),
)
