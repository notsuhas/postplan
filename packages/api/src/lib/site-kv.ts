import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { utf8Bytes } from '../../../shared/kv'
import { siteKv } from '../db/schema'

// Storage behind `window.storage` (the API Claude artifacts expose): string values under string keys,
// either personal to the viewer or shared by everyone who can open the site. Nothing is stored
// unless a page asks; rows go with the site, and personal rows with their user.

/** Every pool (each viewer's personal keys, and the shared keys) is capped on its own, so no one can fill another's. */
export const KV_PERSONAL_QUOTA = { bytes: 5_000_000, keys: 1_000 }
export const KV_SHARED_QUOTA = { bytes: 10_000_000, keys: 10_000 }
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
  // A case-sensitive range over the primary key; U+10FFFF sorts after any key with this prefix.
  const rows = await db
    .select({ key: siteKv.key })
    .from(siteKv)
    .where(and(scope(siteId, ownerId), gte(siteKv.key, prefix), lt(siteKv.key, `${prefix}\u{10FFFF}`)))
    .orderBy(siteKv.key)
    .limit(KV_LIST_LIMIT)
  return rows.map((r) => r.key)
}

/** Upsert in ONE statement, so concurrent writes can't jointly pass a quota; false when over it. */
export async function setKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string, value: string) {
  const bytes = utf8Bytes(key) + utf8Bytes(value)
  const quota = ownerId === '' ? KV_SHARED_QUOTA : KV_PERSONAL_QUOTA
  const rows = await db.all<{ key: string }>(sql`
    WITH others AS (
      SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS keys FROM site_kv
      WHERE siteId = ${siteId} AND ownerId = ${ownerId} AND key != ${key}
    )
    INSERT INTO site_kv (siteId, ownerId, key, value, bytes, updatedAt)
    SELECT ${siteId}, ${ownerId}, ${key}, ${value}, ${bytes}, ${new Date().toISOString()}
    FROM others WHERE others.bytes + ${bytes} <= ${quota.bytes} AND others.keys < ${quota.keys}
    ON CONFLICT (siteId, ownerId, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, updatedAt = excluded.updatedAt
    RETURNING key`)
  return rows.length === 1
}

export async function deleteKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string) {
  await db.delete(siteKv).where(and(scope(siteId, ownerId), eq(siteKv.key, key)))
}
