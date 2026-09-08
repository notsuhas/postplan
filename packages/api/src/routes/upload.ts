import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { NewFileRow, Site } from '../db/schema'
import {
  feedbackBatches,
  files,
  sites,
  siteVersionFiles,
  siteVersions,
  spaceMembers,
  spaces,
  siteUserShares,
} from '../db/schema'
import { recordAction } from '../db/action-ledger'
import { replayIdempotent, sha256Hex, stableRequestHash, storeIdempotent } from '../db/idempotency'
import { canReplace } from '../lib/access'
import { cliNeedsUpgrade } from '../lib/cli-version'
import { batchAll } from '../lib/d1'
import { capTitle, extractHtmlMeta, NO_META, pickEntry } from '../lib/extract'
import { cleanDisplayText } from '../lib/untrusted-text'
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
type ExistingSite = Pick<
  Site,
  'id' | 'ownerId' | 'contentVersion' | 'status' | 'visibility' | 'description' | 'lastReplacedBy'
>
type UploadFacts = {
  spaceId: string | null
  existing: ExistingSite | undefined
  isMember: boolean
  shareRole: 'viewer' | 'editor' | null
  oldFiles: NewFileRow[]
}
type ParsedUpload = {
  hasVisibility: boolean
  visibility: unknown
  title: string | null
  expectedVersion: number | null
  changeNotes: string | null
  feedbackBatchId: string | null
  items: UploadItem[]
}
type UploadTarget = {
  siteId: string
  storedSlug: string
  isCreate: boolean
  actingAsEditor: boolean
  oldFiles: NewFileRow[]
  existingVersion: number | null
  existingDescription: string | null
  existingCreatedBy: string | null
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
  changeNotes: string | null
  feedbackBatchId: string | null
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
  const rawChangeNotes = form.get('changeNotes')
  const rawFeedbackBatchId = form.get('feedbackBatchId')
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
    changeNotes: typeof rawChangeNotes === 'string' ? cleanDisplayText(rawChangeNotes, 2_000) : null,
    feedbackBatchId: typeof rawFeedbackBatchId === 'string' ? rawFeedbackBatchId.trim().slice(0, 200) || null : null,
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
        description: sites.description,
        lastReplacedBy: sites.lastReplacedBy,
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
      .select({
        id: files.id,
        siteId: files.siteId,
        path: files.path,
        storageKey: files.storageKey,
        mimeType: files.mimeType,
        size: files.size,
        etag: files.etag,
        contentHash: files.contentHash,
        createdAt: files.createdAt,
      })
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
    oldFiles: existingFileRows,
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
      oldFiles: [],
      existingVersion: null,
      existingDescription: null,
      existingCreatedBy: null,
    }
  }

  const isOwner = facts.existing.ownerId === user.id
  if (!canReplace(user, facts.existing, isOwner ? null : facts.shareRole)) {
    return c.json({ error: 'forbidden' }, 403)
  }
  const actingAsEditor = !isOwner
  if (actingAsEditor && facts.existing.status === 'archived') return c.json({ error: 'site archived' }, 403)
  if (actingAsEditor && expectedVersion === null) return c.json({ error: 'expectedVersion required' }, 400)
  if (facts.oldFiles.length > 0 && c.req.query('replace') !== 'true') {
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
    oldFiles: facts.oldFiles,
    existingVersion: facts.existing.contentVersion,
    existingDescription: facts.existing.description,
    existingCreatedBy: facts.existing.lastReplacedBy ?? facts.existing.ownerId,
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
  const { target, plan, spaceId, user, visibility, title, derivedTitle, description, changeNotes, feedbackBatchId } =
    input
  const newRows = plan.map(({ row }) => row)
  const insertRows = newRows.map((row) => db.insert(files).values(row))
  const newKeys = newRows.map(({ storageKey }) => storageKey)

  try {
    if (target.isCreate) {
      const versionId = `${target.siteId}:v0`
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
        db.insert(siteVersions).values({
          id: versionId,
          siteId: target.siteId,
          version: 0,
          description,
          changeNotes,
          feedbackBatchId,
          createdBy: user.id,
        }),
        ...newRows.map((row) =>
          db.insert(siteVersionFiles).values({
            id: crypto.randomUUID(),
            versionId,
            path: row.path,
            storageKey: row.storageKey,
            mimeType: row.mimeType,
            size: row.size,
            etag: row.etag,
          }),
        ),
      ])
    } else {
      const conflict = await replaceExisting(c, input)
      if (conflict) return conflict
    }
  } catch (error) {
    await deleteKeys(c.env.POSTPLAN_FILES, newKeys)
    throw error
  }
  return null
}

async function replaceExisting(c: UploadContext, input: PersistUpload): Promise<Response | null> {
  const db = c.get('db')
  const { target, user, expectedVersion, description, hasVisibility, visibility, derivedTitle } = input
  const version = target.actingAsEditor ? (expectedVersion as number) : (target.existingVersion as number)
  const matchesVersion = () =>
    sql`exists (select 1 from ${sites} where ${sites.id} = ${target.siteId} and ${sites.contentVersion} = ${version})`
  const createdAt = new Date().toISOString()
  const previousVersionId = `${target.siteId}:v${version}`
  const nextVersion = version + 1
  const nextVersionId = `${target.siteId}:v${nextVersion}`
  const conditionalInserts = input.plan.map(({ row }) =>
    db
      .insert(files)
      .select(
        sql`select ${row.id}, ${row.siteId}, ${row.path}, ${row.storageKey}, ${row.mimeType}, ${row.size}, ${row.etag}, null, ${createdAt} where ${matchesVersion()}`,
      ),
  )
  const results = await db.batch([
    db
      .insert(siteVersions)
      .select(
        sql`select ${previousVersionId}, ${target.siteId}, ${version}, ${target.existingDescription}, ${null}, ${null}, ${null}, ${target.existingCreatedBy}, ${createdAt} where ${matchesVersion()}`,
      )
      .onConflictDoNothing(),
    ...target.oldFiles.map((row) =>
      db
        .insert(siteVersionFiles)
        .select(
          sql`select ${crypto.randomUUID()}, ${previousVersionId}, ${row.path}, ${row.storageKey}, ${row.mimeType}, ${row.size}, ${row.etag} where ${matchesVersion()}`,
        )
        .onConflictDoNothing(),
    ),
    db.delete(files).where(and(eq(files.siteId, target.siteId), matchesVersion())),
    ...conditionalInserts,
    db
      .insert(siteVersions)
      .select(
        sql`select ${nextVersionId}, ${target.siteId}, ${nextVersion}, ${description}, ${input.changeNotes}, ${input.feedbackBatchId}, ${null}, ${user.id}, ${createdAt} where ${matchesVersion()}`,
      ),
    ...input.plan.map(({ row }) =>
      db
        .insert(siteVersionFiles)
        .select(
          sql`select ${crypto.randomUUID()}, ${nextVersionId}, ${row.path}, ${row.storageKey}, ${row.mimeType}, ${row.size}, ${row.etag} where ${matchesVersion()}`,
        ),
    ),
    db
      .update(sites)
      .set({
        contentVersion: sql`${sites.contentVersion} + 1`,
        lastReplacedBy: user.id,
        updatedAt: createdAt,
        slug: target.storedSlug,
        ...(!target.actingAsEditor && hasVisibility && isVisibility(visibility) ? { visibility } : {}),
        ...(!target.actingAsEditor && derivedTitle !== null
          ? { title: sql`coalesce(${sites.title}, ${derivedTitle})` }
          : {}),
        description,
      })
      .where(and(eq(sites.id, target.siteId), eq(sites.contentVersion, version)))
      .returning({ id: sites.id }),
  ])
  const claimed = results[results.length - 1] as { id: string }[]
  if (claimed.length === 0) {
    await deleteKeys(
      c.env.POSTPLAN_FILES,
      input.plan.map(({ row }) => row.storageKey),
    )
    return c.json({ error: 'version conflict', conflict: true }, 409)
  }
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
  const idempotencyKey = c.req.header('Idempotency-Key')?.trim() || null
  let requestHash: string | null = null
  if (idempotencyKey) {
    const files = []
    for (const { path, file } of parsed.items) {
      files.push({ path, size: file.size, type: file.type, contentHash: await sha256Hex(await file.arrayBuffer()) })
    }
    requestHash = await stableRequestHash({
      spaceSlug,
      siteSlug,
      expectedVersion: parsed.expectedVersion,
      visibility: parsed.hasVisibility ? parsed.visibility : null,
      changeNotes: parsed.changeNotes,
      feedbackBatchId: parsed.feedbackBatchId,
      files,
    })
    const replay = await replayIdempotent(db, user.id, 'site.publish', idempotencyKey, requestHash)
    if (replay.kind === 'conflict') return c.json({ error: 'idempotency key reused with different request' }, 409)
    if (replay.kind === 'replay') return c.json(replay.response, replay.statusCode as 200)
  }
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

  if (parsed.feedbackBatchId) {
    const batch = await db
      .select({ siteId: feedbackBatches.siteId, claimedBy: feedbackBatches.claimedBy, status: feedbackBatches.status })
      .from(feedbackBatches)
      .where(eq(feedbackBatches.id, parsed.feedbackBatchId))
      .limit(1)
      .then((rows) => rows[0])
    if (!batch || batch.siteId !== target.siteId || batch.claimedBy !== user.id || batch.status !== 'claimed') {
      return c.json({ error: 'feedback batch is not claimed by this actor for this site' }, 409)
    }
  }

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
    changeNotes: parsed.changeNotes,
    feedbackBatchId: parsed.feedbackBatchId,
  })
  if (persistError) return persistError

  const response = {
    url: `${c.env.APP_URL}/${spaceSlug}/${target.storedSlug}`,
    siteSlug: target.storedSlug,
    fileCount: plan.length,
    contentVersion: target.existingVersion === null ? 0 : target.existingVersion + 1,
  }
  if (idempotencyKey && requestHash) {
    await storeIdempotent(db, user.id, 'site.publish', idempotencyKey, requestHash, 200, response)
  }
  await recordAction(db, {
    actorId: user.id,
    action: 'site.publish',
    authorization: c.get('credential').kind,
    siteId: target.siteId,
    siteVersion: response.contentVersion,
    targetId: parsed.feedbackBatchId,
    idempotencyKey,
    metadata: { fileCount: plan.length, changeNotes: parsed.changeNotes },
  })
  return c.json(response)
}

export const upload = new Hono<AppEnv>()

upload.post(
  '/:spaceSlug/:siteSlug',
  requireAuth,
  requireControlGrant,
  async (c, next) => {
    const minimum = c.env.MIN_CLI_VERSION?.trim()
    const userAgent = c.req.header('User-Agent')
    const isCliRequest = c.get('credential').kind === 'cli' || userAgent?.startsWith('postplan-cli/')
    if (minimum && isCliRequest && cliNeedsUpgrade(userAgent, minimum)) {
      return c.json(
        {
          error: 'cli_upgrade_required',
          minimumVersion: minimum,
          message: `Postplan CLI ${minimum} or newer is required. Run \`postplan upgrade\`, then retry this deploy.`,
        },
        426,
        { 'X-Postplan-Min-CLI-Version': minimum },
      )
    }
    await next()
  },
  handleUpload,
)
