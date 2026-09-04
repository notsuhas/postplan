import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { NewFileRow, Site } from '../db/schema'
import { files, sites, spaceMembers, spaces, siteUserShares } from '../db/schema'
import { canReplace } from '../lib/access'
import { batchAll } from '../lib/d1'
import { fireAndForget } from '../lib/events'
import { capTitle, extractHtmlMeta, NO_META, pickEntry } from '../lib/extract'
import { isValidSlug, slugForVisibility } from '../lib/slug'
import { deleteKeys, MAX_FILE_BYTES, sanitizePath } from '../lib/storage'
import { isVisibility } from '../lib/visibility'
import { requireAuth, requireControlGrant } from '../middleware/auth'
import type { AppEnv, SessionUser } from '../types'

const enc = new TextEncoder()
const MAX_FILE_COUNT = 200
const MAX_TOTAL_BYTES = 100 * 1024 * 1024
const MAX_STORAGE_KEY_BYTES = 1024
const UPLOAD_CONCURRENCY = 10

type UploadContext = Context<AppEnv>
type UploadItem = { path: string; file: File }
type UploadPlanItem = { file: File; row: NewFileRow }
type ExistingSite = Pick<Site, 'id' | 'ownerId' | 'contentVersion' | 'status' | 'visibility'>
type UploadFacts = {
  spaceId: string | null
  existing: ExistingSite | undefined
  isMember: boolean
  shareRole: 'viewer' | 'editor' | null
  oldKeys: string[]
}
type ParsedUpload = {
  hasVisibility: boolean
  visibility: unknown
  title: string | null
  expectedVersion: number | null
  items: UploadItem[]
}
type UploadTarget = {
  siteId: string
  storedSlug: string
  isCreate: boolean
  actingAsEditor: boolean
  oldKeys: string[]
  existingVersion: number | null
}
type PersistUpload = {
  target: UploadTarget
  plan: UploadPlanItem[]
  spaceId: string
  user: SessionUser
  visibility: unknown
  hasVisibility: boolean
  title: string | null
  derivedTitle: string | null
  description: string | null
  expectedVersion: number | null
}

async function enforceRateLimit(c: UploadContext): Promise<Response | null> {
  if (!c.env.UPLOAD_LIMITER) return null
  const ip = c.req.header('CF-Connecting-IP') ?? 'local'
  const { success } = await c.env.UPLOAD_LIMITER.limit({ key: ip })
  return success ? null : c.json({ error: 'rate limited' }, 429)
}

async function parseUpload(c: UploadContext): Promise<ParsedUpload | Response> {
  const contentLength = Number(c.req.header('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_BYTES) {
    return c.json({ error: 'upload exceeds 100MB total' }, 413)
  }

  const form = await c.req.formData()
  const rawVisibility = form.get('visibility')
  const rawTitle = form.get('title')
  const rawExpected = form.get('expectedVersion')
  const items: UploadItem[] = []

  for (const file of form.getAll('files').filter((value): value is File => value instanceof File)) {
    if (file.size > MAX_FILE_BYTES) return c.json({ error: 'file exceeds 20MB' }, 413)
    const path = sanitizePath(file.name)
    if (path) items.push({ path, file })
  }

  const validationError = validateItems(c, items)
  if (validationError) return validationError
  const visibility = rawVisibility || 'team'
  if (!isVisibility(visibility)) return c.json({ error: 'invalid visibility' }, 400)

  return {
    hasVisibility: typeof rawVisibility === 'string' && rawVisibility !== '',
    visibility,
    title: typeof rawTitle === 'string' ? capTitle(rawTitle.trim()) || null : null,
    expectedVersion:
      typeof rawExpected === 'string' && rawExpected.trim() !== '' && Number.isInteger(Number(rawExpected))
        ? Number(rawExpected)
        : null,
    items,
  }
}

function validateItems(c: UploadContext, items: UploadItem[]): Response | null {
  if (items.length === 0) return c.json({ error: 'no files' }, 400)
  if (items.reduce((sum, { file }) => sum + file.size, 0) > MAX_TOTAL_BYTES) {
    return c.json({ error: 'upload exceeds 100MB total' }, 413)
  }
  if (items.length > MAX_FILE_COUNT) return c.json({ error: 'too many files', max: MAX_FILE_COUNT }, 400)

  const seenPaths = new Set<string>()
  for (const { path } of items) {
    if (seenPaths.has(path)) return c.json({ error: 'duplicate path', path }, 400)
    seenPaths.add(path)
  }
  return null
}

async function readUploadFacts(
  db: DrizzleD1Database,
  spaceSlug: string,
  siteSlug: string,
  userId: string,
): Promise<UploadFacts> {
  const slugKey = () => and(eq(spaces.slug, spaceSlug), eq(sites.slug, siteSlug))
  const [spaceRows, existingRows, memberRows, shareRoleRows, existingFileRows] = await batchAll(db, [
    db.select({ id: spaces.id }).from(spaces).where(eq(spaces.slug, spaceSlug)).limit(1),
    db
      .select({
        id: sites.id,
        ownerId: sites.ownerId,
        contentVersion: sites.contentVersion,
        status: sites.status,
        visibility: sites.visibility,
      })
      .from(sites)
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(slugKey())
      .limit(1),
    db
      .select({ userId: spaceMembers.userId })
      .from(spaceMembers)
      .innerJoin(spaces, eq(spaceMembers.spaceId, spaces.id))
      .where(and(eq(spaces.slug, spaceSlug), eq(spaceMembers.userId, userId)))
      .limit(1),
    db
      .select({ role: siteUserShares.role })
      .from(siteUserShares)
      .innerJoin(sites, eq(siteUserShares.siteId, sites.id))
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(and(slugKey(), eq(siteUserShares.userId, userId)))
      .limit(1),
    db
      .select({ storageKey: files.storageKey })
      .from(files)
      .innerJoin(sites, eq(files.siteId, sites.id))
      .innerJoin(spaces, eq(sites.spaceId, spaces.id))
      .where(slugKey()),
  ])

  return {
    spaceId: spaceRows[0]?.id ?? null,
    existing: existingRows[0],
    isMember: memberRows.length > 0,
    shareRole: shareRoleRows[0]?.role ?? null,
    oldKeys: existingFileRows.map(({ storageKey }) => storageKey),
  }
}

function resolveTarget(
  c: UploadContext,
  facts: UploadFacts,
  user: SessionUser,
  siteSlug: string,
  visibility: unknown,
  hasVisibility: boolean,
  expectedVersion: number | null,
): UploadTarget | Response {
  if (!facts.spaceId) return c.json({ error: 'space not found' }, 404)
  if (!facts.existing) {
    if (!facts.isMember) return c.json({ error: 'forbidden' }, 403)
    if (!isValidSlug(siteSlug)) return c.json({ error: 'invalid siteSlug' }, 400)
    return {
      siteId: crypto.randomUUID(),
      storedSlug: slugForVisibility(siteSlug, visibility),
      isCreate: true,
      actingAsEditor: false,
      oldKeys: [],
      existingVersion: null,
    }
  }

  const isOwner = facts.existing.ownerId === user.id
  if (!canReplace(user, facts.existing, isOwner ? null : facts.shareRole)) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const actingAsEditor = !isOwner
  if (actingAsEditor && facts.existing.status === 'archived') return c.json({ error: 'site archived' }, 403)
  if (actingAsEditor && expectedVersion === null) return c.json({ error: 'expectedVersion required' }, 400)
  if (facts.oldKeys.length > 0 && c.req.query('replace') !== 'true') {
    return c.json({ error: 'site exists', conflict: true }, 409)
  }

  return {
    siteId: facts.existing.id,
    storedSlug:
      isOwner && hasVisibility && visibility === 'unlisted' && facts.existing.visibility !== 'unlisted'
        ? slugForVisibility(siteSlug, visibility)
        : siteSlug,
    isCreate: false,
    actingAsEditor,
    oldKeys: facts.oldKeys,
    existingVersion: facts.existing.contentVersion,
  }
}

function buildPlan(c: UploadContext, items: UploadItem[], siteId: string): UploadPlanItem[] | Response {
  const prefix = crypto.randomUUID()
  const plan = items.map(({ path, file }) => ({
    file,
    row: {
      id: crypto.randomUUID(),
      siteId,
      path,
      storageKey: `${prefix}/${path}`,
      mimeType: file.type || null,
      size: file.size,
      etag: null,
    } satisfies NewFileRow,
  }))
  const invalid = plan.find(({ row }) => enc.encode(row.storageKey).byteLength > MAX_STORAGE_KEY_BYTES)
  return invalid ? c.json({ error: 'storage key too long', path: invalid.row.path }, 400) : plan
}

async function writeObjects(bucket: R2Bucket, plan: UploadPlanItem[]): Promise<void> {
  const attempted: string[] = []
  try {
    for (let index = 0; index < plan.length; index += UPLOAD_CONCURRENCY) {
      await Promise.all(
        plan.slice(index, index + UPLOAD_CONCURRENCY).map(async ({ file, row }) => {
          attempted.push(row.storageKey)
          const contentType = file.type || 'application/octet-stream'
          const put = await bucket.put(row.storageKey, file.stream(), { httpMetadata: { contentType } })
          row.etag = put?.httpEtag ?? null
        }),
      )
    }
  } catch (error) {
    await deleteKeys(bucket, attempted)
    throw error
  }
}

async function persistUpload(c: UploadContext, input: PersistUpload): Promise<Response | null> {
  const db = c.get('db')
  const { target, plan, spaceId, user, visibility, hasVisibility, title, derivedTitle, description } = input
  const newRows = plan.map(({ row }) => row)
  const insertRows = newRows.map((row) => db.insert(files).values(row))
  const newKeys = newRows.map(({ storageKey }) => storageKey)

  try {
    if (target.isCreate) {
      await db.batch([
        db.insert(sites).values({
          id: target.siteId,
          spaceId,
          slug: target.storedSlug,
          title: title ?? derivedTitle,
          description,
          visibility: isVisibility(visibility) ? visibility : 'team',
          ownerId: user.id,
        }),
        ...insertRows,
      ])
    } else if (target.actingAsEditor) {
      const conflict = await replaceAsEditor(c, input)
      if (conflict) return conflict
    } else {
      await db.batch([
        db.delete(files).where(eq(files.siteId, target.siteId)),
        ...insertRows,
        db
          .update(sites)
          .set({
            contentVersion: sql`${sites.contentVersion} + 1`,
            lastReplacedBy: user.id,
            updatedAt: new Date().toISOString(),
            slug: target.storedSlug,
            ...(hasVisibility && isVisibility(visibility) ? { visibility } : {}),
            ...(derivedTitle !== null ? { title: sql`coalesce(${sites.title}, ${derivedTitle})` } : {}),
            description,
          })
          .where(eq(sites.id, target.siteId)),
      ])
    }
  } catch (error) {
    await deleteKeys(c.env.POSTPLAN_FILES, newKeys)
    throw error
  }
  return null
}

async function replaceAsEditor(c: UploadContext, input: PersistUpload): Promise<Response | null> {
  const db = c.get('db')
  const { target, user, expectedVersion, description } = input
  const claimed = await db
    .update(sites)
    .set({
      contentVersion: sql`${sites.contentVersion} + 1`,
      lastReplacedBy: user.id,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(sites.id, target.siteId), eq(sites.contentVersion, expectedVersion as number)))
    .returning({ id: sites.id })
  if (claimed.length === 0) {
    await deleteKeys(
      c.env.POSTPLAN_FILES,
      input.plan.map(({ row }) => row.storageKey),
    )
    return c.json({ error: 'version conflict', conflict: true }, 409)
  }
  await db.batch([
    db.delete(files).where(eq(files.siteId, target.siteId)),
    ...input.plan.map(({ row }) => db.insert(files).values(row)),
    db.update(sites).set({ description }).where(eq(sites.id, target.siteId)),
  ])
  return null
}

async function handleUpload(c: UploadContext): Promise<Response> {
  const rateLimitError = await enforceRateLimit(c)
  if (rateLimitError) return rateLimitError

  const parsed = await parseUpload(c)
  if (parsed instanceof Response) return parsed

  const user = c.get('user')
  const db = c.get('db')
  const { spaceSlug, siteSlug } = c.req.param()
  const facts = await readUploadFacts(db, spaceSlug, siteSlug, user.id)
  const target = resolveTarget(
    c,
    facts,
    user,
    siteSlug,
    parsed.visibility,
    parsed.hasVisibility,
    parsed.expectedVersion,
  )
  if (target instanceof Response) return target

  const plan = buildPlan(c, parsed.items, target.siteId)
  if (plan instanceof Response) return plan
  const entry = pickEntry(parsed.items.map(({ path, file }) => ({ path, file, mimeType: file.type || null })))
  const metaPromise = entry ? extractHtmlMeta(entry, entry.file) : Promise.resolve(NO_META)
  await writeObjects(c.env.POSTPLAN_FILES, plan)

  const meta = await metaPromise
  const persistError = await persistUpload(c, {
    target,
    plan,
    spaceId: facts.spaceId as string,
    user,
    visibility: parsed.visibility,
    hasVisibility: parsed.hasVisibility,
    title: parsed.title,
    derivedTitle: target.actingAsEditor ? null : meta.title,
    description: meta.description,
    expectedVersion: parsed.expectedVersion,
  })
  if (persistError) return persistError

  if (!target.isCreate && target.oldKeys.length > 0) {
    await fireAndForget(c, deleteKeys(c.env.POSTPLAN_FILES, target.oldKeys))
  }
  return c.json({
    url: `${c.env.APP_URL}/${spaceSlug}/${target.storedSlug}`,
    siteSlug: target.storedSlug,
    fileCount: plan.length,
    contentVersion: target.existingVersion === null ? 0 : target.existingVersion + 1,
  })
}

export const upload = new Hono<AppEnv>()

upload.post('/:spaceSlug/:siteSlug', requireAuth, requireControlGrant, handleUpload)
