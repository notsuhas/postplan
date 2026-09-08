import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm'
import { Hono } from 'hono'
import { recordAction } from '../db/action-ledger'
import { replayIdempotent, stableRequestHash, storeIdempotent } from '../db/idempotency'
import { resolveShareRole } from '../db/repo'
import {
  commentThreads,
  comments,
  feedbackBatchItems,
  feedbackBatches,
  siteVersions,
  spaces,
  sites,
  users,
} from '../db/schema'
import { resolveSiteForAccess } from '../lib/site-access'
import { canReplace } from '../lib/access'
import { requireAuth, requireControlGrant } from '../middleware/auth'
import type { AppEnv } from '../types'

const MAX_BATCH_ITEMS = 100
const UNDO_MS = 5_000
const MAX_KEY = 160

type FeedbackItemView = {
  commentId: string
  threadId: string
  page: string
  selector: string | null
  sourceContext: unknown
  anchorType: 'text' | 'page' | 'element'
  anchorStatus: 'anchored' | 'shifted' | 'suggested' | 'orphaned'
  quote: string | null
  author: { id: string | null; name: string }
  text: string
  version: number
  anchorVersion: number
  createdAt: string
}

type FeedbackBatchView = {
  id: string
  site: { space: string; slug: string }
  siteVersion: number
  status: 'queued' | 'claimed' | 'completed' | 'cancelled'
  claimableAt: string
  createdAt: string
  claimedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  completedVersion: number | null
  items: FeedbackItemView[]
}

function keyFrom(request: Request): string | null {
  const key = request.headers.get('Idempotency-Key')?.trim()
  return key && key.length <= MAX_KEY ? key : null
}

async function loadBatch(db: AppEnv['Variables']['db'], batchId: string): Promise<FeedbackBatchView | null> {
  const row = await db
    .select({ batch: feedbackBatches, space: spaces.slug, slug: sites.slug })
    .from(feedbackBatches)
    .innerJoin(sites, eq(feedbackBatches.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .where(eq(feedbackBatches.id, batchId))
    .limit(1)
    .then((rows) => rows[0])
  if (!row) return null
  const items = await db
    .select({
      commentId: feedbackBatchItems.commentId,
      threadId: feedbackBatchItems.threadId,
      page: feedbackBatchItems.page,
      selector: feedbackBatchItems.selector,
      sourceContext: feedbackBatchItems.sourceContext,
      anchorType: feedbackBatchItems.anchorType,
      anchorStatus: feedbackBatchItems.anchorStatus,
      quote: feedbackBatchItems.quote,
      anchorVersion: feedbackBatchItems.anchorVersion,
      authorId: feedbackBatchItems.authorId,
      authorName: feedbackBatchItems.authorName,
      text: feedbackBatchItems.text,
      version: feedbackBatchItems.version,
      createdAt: feedbackBatchItems.commentCreatedAt,
    })
    .from(feedbackBatchItems)
    .where(eq(feedbackBatchItems.batchId, batchId))
    .orderBy(asc(feedbackBatchItems.commentCreatedAt), asc(feedbackBatchItems.commentId))
  return {
    id: row.batch.id,
    site: { space: row.space, slug: row.slug },
    siteVersion: row.batch.siteVersion,
    status: row.batch.status,
    claimableAt: row.batch.claimableAt,
    createdAt: row.batch.createdAt,
    claimedAt: row.batch.claimedAt,
    completedAt: row.batch.completedAt,
    cancelledAt: row.batch.cancelledAt,
    completedVersion: row.batch.completedVersion,
    items: items.map((item) => ({
      commentId: item.commentId,
      threadId: item.threadId,
      page: item.page,
      selector: item.selector,
      sourceContext: item.sourceContext,
      anchorType: item.anchorType,
      anchorStatus: item.anchorStatus,
      quote: item.quote,
      author: { id: item.authorId, name: item.authorName },
      text: item.text,
      version: item.version,
      anchorVersion: item.anchorVersion,
      createdAt: item.createdAt,
    })),
  }
}

async function batchSite(db: AppEnv['Variables']['db'], id: string) {
  return db
    .select({ batch: feedbackBatches, space: spaces.slug, slug: sites.slug })
    .from(feedbackBatches)
    .innerJoin(sites, eq(feedbackBatches.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .where(eq(feedbackBatches.id, id))
    .limit(1)
    .then((rows) => rows[0] ?? null)
}

export const feedback = new Hono<AppEnv>()
// This router mounts at `/api`, so keep its middleware scoped to the feedback
// surface. A catch-all here would authenticate every later `/api/*` route and
// change both unknown-route semantics and the carefully budgeted D1 reads of
// unrelated endpoints.
for (const path of ['/sites/:space/:site/feedback', '/sites/:space/:site/feedback/*', '/feedback', '/feedback/*']) {
  feedback.use(path, requireAuth)
  feedback.use(path, requireControlGrant)
}

feedback.post('/sites/:space/:site/feedback', async (c) => {
  const key = keyFrom(c.req.raw)
  if (!key) return c.json({ error: 'Idempotency-Key required' }, 400)
  const body = (await c.req.json().catch(() => null)) as { commentIds?: unknown; allOpen?: unknown } | null
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const user = c.get('user')
  const db = c.get('db')
  const { space, site: siteSlug } = c.req.param()
  const access = await resolveSiteForAccess(db, space, siteSlug, user)
  if (!access.site) return c.json({ error: 'not found' }, 404)
  if (!access.access.ok) return c.json({ error: 'forbidden' }, access.access.status)
  const reviewedSite = access.site

  const explicit = Array.isArray(body.commentIds)
    ? [...new Set(body.commentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const allOpen = body.allOpen === true
  if ((!allOpen && explicit.length === 0) || explicit.length > MAX_BATCH_ITEMS)
    return c.json({ error: 'select between 1 and 100 comments' }, 400)
  const requestHash = await stableRequestHash({
    allOpen,
    commentIds: [...explicit].sort(),
    siteId: access.site.id,
  })
  const existing = await db
    .select({ id: feedbackBatches.id, requestHash: feedbackBatches.requestHash })
    .from(feedbackBatches)
    .where(and(eq(feedbackBatches.createdBy, user.id), eq(feedbackBatches.idempotencyKey, key)))
    .limit(1)
    .then((rows) => rows[0])
  if (existing) {
    if (existing.requestHash !== requestHash) return c.json({ error: 'idempotency conflict' }, 409)
    const replay = await loadBatch(db, existing.id)
    return replay ? c.json(replay, 200) : c.json({ error: 'not found' }, 404)
  }

  const predicates = [
    eq(commentThreads.siteId, access.site.id),
    eq(commentThreads.status, 'open'),
    isNull(comments.deletedAt),
  ]
  if (!allOpen) predicates.push(inArray(comments.id, explicit))
  const selected = await db
    .select({
      commentId: comments.id,
      threadId: comments.threadId,
      page: commentThreads.filePath,
      sourceContext: commentThreads.anchor,
      anchorType: commentThreads.anchorType,
      anchorStatus: commentThreads.anchorStatus,
      quote: commentThreads.quote,
      anchorVersion: commentThreads.createdVersion,
      authorId: comments.authorId,
      authorName: users.name,
      authorEmail: users.email,
      text: comments.body,
      commentCreatedAt: comments.createdAt,
    })
    .from(comments)
    .innerJoin(commentThreads, eq(comments.threadId, commentThreads.id))
    .leftJoin(users, eq(comments.authorId, users.id))
    .where(and(...predicates))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(MAX_BATCH_ITEMS + 1)
  if (selected.length === 0 || selected.length > MAX_BATCH_ITEMS || (!allOpen && selected.length !== explicit.length))
    return c.json({ error: 'one or more comments are unavailable' }, 400)

  const now = new Date()
  const batchId = crypto.randomUUID()
  await db.batch([
    db.insert(feedbackBatches).values({
      id: batchId,
      siteId: access.site.id,
      siteVersion: access.site.contentVersion,
      status: 'queued',
      createdBy: user.id,
      claimedBy: null,
      idempotencyKey: key,
      requestHash,
      claimableAt: new Date(now.getTime() + UNDO_MS).toISOString(),
      createdAt: now.toISOString(),
    }),
    db.insert(feedbackBatchItems).values(
      selected.map((item) => {
        const element =
          item.anchorType === 'element' && item.sourceContext && typeof item.sourceContext === 'object'
            ? (item.sourceContext as { selector?: unknown })
            : null
        return {
          batchId,
          commentId: item.commentId,
          threadId: item.threadId,
          page: item.page,
          selector: typeof element?.selector === 'string' ? element.selector : null,
          sourceContext: item.sourceContext,
          anchorType: item.anchorType,
          anchorStatus: item.anchorStatus,
          quote: item.quote,
          authorId: item.authorId,
          authorName: item.authorName ?? item.authorEmail ?? 'unknown',
          text: item.text,
          version: reviewedSite.contentVersion,
          anchorVersion: item.anchorVersion,
          commentCreatedAt: item.commentCreatedAt,
        }
      }),
    ),
  ])
  await recordAction(db, {
    actorId: user.id,
    action: 'feedback.send',
    authorization: c.get('credential').kind,
    siteId: access.site.id,
    siteVersion: access.site.contentVersion,
    targetId: batchId,
    idempotencyKey: key,
    metadata: { count: selected.length },
  })
  return c.json((await loadBatch(db, batchId))!, 201)
})

feedback.post('/sites/:space/:site/feedback/:batchId/undo', async (c) => {
  const key = keyFrom(c.req.raw)
  if (!key) return c.json({ error: 'Idempotency-Key required' }, 400)
  const db = c.get('db')
  const user = c.get('user')
  const { space, site: siteSlug, batchId } = c.req.param()
  const requestHash = await stableRequestHash({ batchId })
  const replay = await replayIdempotent(db, user.id, 'feedback.undo', key, requestHash)
  if (replay.kind === 'conflict') return c.json({ error: 'idempotency conflict' }, 409)
  if (replay.kind === 'replay') return c.json(replay.response, replay.statusCode as 200)
  const access = await resolveSiteForAccess(db, space, siteSlug, user)
  if (!access.site) return c.json({ error: 'not found' }, 404)
  if (!access.access.ok) return c.json({ error: 'forbidden' }, access.access.status)
  const now = new Date().toISOString()
  const changed = await db
    .update(feedbackBatches)
    .set({ status: 'cancelled', cancelledAt: now })
    .where(
      and(
        eq(feedbackBatches.id, batchId),
        eq(feedbackBatches.siteId, access.site.id),
        eq(feedbackBatches.createdBy, user.id),
        eq(feedbackBatches.status, 'queued'),
        gte(feedbackBatches.claimableAt, now),
      ),
    )
    .returning({ id: feedbackBatches.id })
  if (changed.length === 0) {
    const existing = await loadBatch(db, batchId)
    if (existing?.status === 'cancelled') return c.json(existing)
    return c.json({ error: 'undo window expired' }, 409)
  }
  await recordAction(db, {
    actorId: user.id,
    action: 'feedback.undo',
    authorization: c.get('credential').kind,
    siteId: access.site.id,
    siteVersion: access.site.contentVersion,
    targetId: batchId,
    idempotencyKey: key,
  })
  const response = (await loadBatch(db, batchId))!
  await storeIdempotent(db, user.id, 'feedback.undo', key, requestHash, 200, response)
  return c.json(response)
})

feedback.get('/feedback', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const now = new Date().toISOString()
  const rows = await db
    .select({ id: feedbackBatches.id, space: spaces.slug, slug: sites.slug })
    .from(feedbackBatches)
    .innerJoin(sites, eq(feedbackBatches.siteId, sites.id))
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .where(and(eq(feedbackBatches.status, 'queued'), lte(feedbackBatches.claimableAt, now)))
    .orderBy(desc(feedbackBatches.createdAt))
  const requestedSite = c.req.query('site')
  const visible: FeedbackBatchView[] = []
  for (const row of rows) {
    if (requestedSite && requestedSite !== `${row.space}/${row.slug}`) continue
    const access = await resolveSiteForAccess(db, row.space, row.slug, user)
    if (!access.site || !access.access.ok) continue
    const role = access.site.ownerId === user.id ? null : await resolveShareRole(db, access.site.id, user.id)
    if (!canReplace(user, access.site, role)) continue
    const view = await loadBatch(db, row.id)
    if (view) visible.push(view)
  }
  return c.json(visible)
})

// A claimed batch is no longer returned by the queue listing, but deploy still needs its durable
// site/version identity. Expose only the claimant's own live claim; this is not a second work queue.
feedback.get('/feedback/:batchId', async (c) => {
  const db = c.get('db')
  const user = c.get('user')
  const row = await batchSite(db, c.req.param('batchId'))
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.batch.status !== 'claimed' || row.batch.claimedBy !== user.id) {
    return c.json({ error: 'feedback batch is not claimed by this actor' }, 409)
  }
  const access = await resolveSiteForAccess(db, row.space, row.slug, user)
  if (!access.site) return c.json({ error: 'not found' }, 404)
  if (!access.access.ok) return c.json({ error: 'forbidden' }, access.access.status)
  const role = access.site.ownerId === user.id ? null : await resolveShareRole(db, access.site.id, user.id)
  if (!canReplace(user, access.site, role)) return c.json({ error: 'forbidden' }, 403)
  return c.json((await loadBatch(db, row.batch.id))!)
})

feedback.post('/feedback/:batchId/claim', async (c) => {
  const key = keyFrom(c.req.raw)
  if (!key) return c.json({ error: 'Idempotency-Key required' }, 400)
  const db = c.get('db')
  const user = c.get('user')
  const batchId = c.req.param('batchId')
  const requestHash = await stableRequestHash({ batchId })
  const replay = await replayIdempotent(db, user.id, 'feedback.claim', key, requestHash)
  if (replay.kind === 'conflict') return c.json({ error: 'idempotency conflict' }, 409)
  if (replay.kind === 'replay') return c.json(replay.response, replay.statusCode as 200)
  const row = await batchSite(db, batchId)
  if (!row) return c.json({ error: 'not found' }, 404)
  const access = await resolveSiteForAccess(db, row.space, row.slug, user)
  if (!access.site) return c.json({ error: 'not found' }, 404)
  if (!access.access.ok) return c.json({ error: 'forbidden' }, access.access.status)
  const role = access.site.ownerId === user.id ? null : await resolveShareRole(db, access.site.id, user.id)
  if (!canReplace(user, access.site, role)) return c.json({ error: 'forbidden' }, 403)
  const now = new Date().toISOString()
  const changed = await db
    .update(feedbackBatches)
    .set({ status: 'claimed', claimedBy: user.id, claimedAt: now })
    .where(
      and(
        eq(feedbackBatches.id, row.batch.id),
        eq(feedbackBatches.status, 'queued'),
        lte(feedbackBatches.claimableAt, now),
      ),
    )
    .returning({ id: feedbackBatches.id })
  if (changed.length === 0) return c.json({ error: 'batch is not claimable' }, 409)
  await recordAction(db, {
    actorId: user.id,
    action: 'feedback.claim',
    authorization: c.get('credential').kind,
    siteId: row.batch.siteId,
    siteVersion: row.batch.siteVersion,
    targetId: row.batch.id,
    idempotencyKey: key,
  })
  const response = (await loadBatch(db, row.batch.id))!
  await storeIdempotent(db, user.id, 'feedback.claim', key, requestHash, 200, response)
  return c.json(response)
})

feedback.post('/feedback/:batchId/complete', async (c) => {
  const key = keyFrom(c.req.raw)
  if (!key) return c.json({ error: 'Idempotency-Key required' }, 400)
  const body = (await c.req.json().catch(() => ({}))) as { version?: unknown }
  const version =
    typeof body.version === 'number' && Number.isInteger(body.version) && body.version >= 0 ? body.version : null
  const db = c.get('db')
  const user = c.get('user')
  const batchId = c.req.param('batchId')
  const requestHash = await stableRequestHash({ batchId, version })
  const replay = await replayIdempotent(db, user.id, 'feedback.complete', key, requestHash)
  if (replay.kind === 'conflict') return c.json({ error: 'idempotency conflict' }, 409)
  if (replay.kind === 'replay') return c.json(replay.response, replay.statusCode as 200)
  const row = await batchSite(db, batchId)
  if (!row) return c.json({ error: 'not found' }, 404)
  const access = await resolveSiteForAccess(db, row.space, row.slug, user)
  if (!access.access.ok) return c.json({ error: 'forbidden' }, access.access.status)
  if (version !== null) {
    const deployment = await db
      .select({ id: siteVersions.id })
      .from(siteVersions)
      .where(
        and(
          eq(siteVersions.siteId, row.batch.siteId),
          eq(siteVersions.version, version),
          eq(siteVersions.feedbackBatchId, row.batch.id),
        ),
      )
      .limit(1)
    if (deployment.length === 0) return c.json({ error: 'version is not linked to this feedback batch' }, 409)
  }
  const now = new Date().toISOString()
  const changed = await db
    .update(feedbackBatches)
    .set({ status: 'completed', completedAt: now, completedVersion: version })
    .where(
      and(
        eq(feedbackBatches.id, row.batch.id),
        eq(feedbackBatches.status, 'claimed'),
        eq(feedbackBatches.claimedBy, user.id),
      ),
    )
    .returning({ id: feedbackBatches.id })
  if (changed.length === 0) return c.json({ error: 'batch is not claimed by this agent' }, 409)
  await recordAction(db, {
    actorId: user.id,
    action: 'feedback.complete',
    authorization: c.get('credential').kind,
    siteId: row.batch.siteId,
    siteVersion: version ?? row.batch.siteVersion,
    targetId: row.batch.id,
    idempotencyKey: key,
  })
  const response = (await loadBatch(db, row.batch.id))!
  await storeIdempotent(db, user.id, 'feedback.complete', key, requestHash, 200, response)
  return c.json(response)
})
