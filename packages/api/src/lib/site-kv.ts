import { and, eq, like, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { utf8Bytes } from '../../../shared/kv'
import { siteKv } from '../db/schema'

// Storage behind `window.storage` (the API Claude artifacts expose): string values under string keys,
// either personal to the viewer or shared by everyone who can open the site. Nothing is stored
// unless a page asks; rows go with the site, and personal rows with their user.

/** UTF-8 bytes of keys plus values. Each viewer's personal keys and the shared pool have their own
 *  cap under the site's, so neither can starve the other. */
const KV_SITE_QUOTA = 20_000_000
export const KV_PERSONAL_QUOTA = 5_000_000
export const KV_SHARED_QUOTA = 10_000_000
export const KV_SITE_KEYS = 10_000
const KV_LIST_LIMIT = 1_000

/** The row owner for a scope: the viewer for personal keys, '' for shared ones. */
export const kvOwner = (shared: boolean, viewerId: string): string => (shared ? '' : viewerId)

const scope = (siteId: string, ownerId: string) => and(eq(siteKv.siteId, siteId), eq(siteKv.ownerId, ownerId))

export async function getKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string) {
  const [row] = await db
    .select({ value: siteKv.value })
    .from(siteKv)
    .where(and(scope(siteId, ownerId), eq(siteKv.key, key)))
    .limit(1)
  return row?.value ?? null
}

export async function listKv(db: DrizzleD1Database, siteId: string, ownerId: string, prefix: string) {
  const escaped = prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  const rows = await db
    .select({ key: siteKv.key })
    .from(siteKv)
    .where(and(scope(siteId, ownerId), like(siteKv.key, sql`${`${escaped}%`} ESCAPE '\\'`)))
    .orderBy(siteKv.key)
    .limit(KV_LIST_LIMIT)
  return rows.map((r) => r.key)
}

/** Upsert in ONE statement, so concurrent writes can't jointly pass a quota; false when over one.
 *  The site totals come from trigger-kept counters; the owner's total scans only that owner's rows. */
export async function setKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string, value: string) {
  const bytes = utf8Bytes(key) + utf8Bytes(value)
  const ownerQuota = ownerId === '' ? KV_SHARED_QUOTA : KV_PERSONAL_QUOTA
  const existing = sql`(SELECT bytes FROM site_kv WHERE siteId = ${siteId} AND ownerId = ${ownerId} AND key = ${key})`
  const rows = await db.all<{ key: string }>(sql`
    INSERT INTO site_kv (siteId, ownerId, key, value, bytes, updatedAt)
    SELECT ${siteId}, ${ownerId}, ${key}, ${value}, ${bytes}, ${new Date().toISOString()}
    FROM sites WHERE id = ${siteId}
      AND kvBytes - coalesce(${existing}, 0) + ${bytes} <= ${KV_SITE_QUOTA}
      AND (kvCount < ${KV_SITE_KEYS} OR ${existing} IS NOT NULL)
      AND (SELECT coalesce(sum(bytes), 0) FROM site_kv WHERE siteId = ${siteId} AND ownerId = ${ownerId} AND key != ${key})
        + ${bytes} <= ${ownerQuota}
    ON CONFLICT (siteId, ownerId, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, updatedAt = excluded.updatedAt
    RETURNING key`)
  return rows.length === 1
}

export async function deleteKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string) {
  await db.delete(siteKv).where(and(scope(siteId, ownerId), eq(siteKv.key, key)))
}
