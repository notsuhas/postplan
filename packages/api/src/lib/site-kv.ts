import { and, eq, gte, lt, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { utf8Bytes } from '../../../shared/kv'
import { siteKv } from '../db/schema'

// Storage behind `window.storage` (the API Claude artifacts expose): string values under string keys,
// private to the viewer. Nothing is stored unless a page asks; rows go with the site and the user.

export const KV_QUOTA = { bytes: 5_000_000, keys: 1_000 }
const KV_LIST_LIMIT = 1_000

const scope = (siteId: string, userId: string) => and(eq(siteKv.siteId, siteId), eq(siteKv.userId, userId))

export async function getKv(db: DrizzleD1Database, siteId: string, userId: string, key: string) {
  const [row] = await db
    .select({ value: siteKv.value })
    .from(siteKv)
    .where(and(scope(siteId, userId), eq(siteKv.key, key)))
    .limit(1)
  return row?.value ?? null
}

export async function listKv(db: DrizzleD1Database, siteId: string, userId: string, prefix: string) {
  // A case-sensitive range over the primary key; U+10FFFF sorts after any key with this prefix.
  const rows = await db
    .select({ key: siteKv.key })
    .from(siteKv)
    .where(and(scope(siteId, userId), gte(siteKv.key, prefix), lt(siteKv.key, `${prefix}\u{10FFFF}`)))
    .orderBy(siteKv.key)
    .limit(KV_LIST_LIMIT)
  return rows.map((r) => r.key)
}

/** Upsert in ONE statement, so concurrent writes can't jointly pass the quota; false when over it. */
export async function setKv(db: DrizzleD1Database, siteId: string, userId: string, key: string, value: string) {
  const bytes = utf8Bytes(key) + utf8Bytes(value)
  const rows = await db.all<{ key: string }>(sql`
    WITH others AS (
      SELECT coalesce(sum(bytes), 0) AS bytes, count(*) AS keys FROM site_kv
      WHERE siteId = ${siteId} AND userId = ${userId} AND key != ${key}
    )
    INSERT INTO site_kv (siteId, userId, key, value, bytes, updatedAt)
    SELECT ${siteId}, ${userId}, ${key}, ${value}, ${bytes}, ${new Date().toISOString()}
    FROM others WHERE others.bytes + ${bytes} <= ${KV_QUOTA.bytes} AND others.keys < ${KV_QUOTA.keys}
    ON CONFLICT (siteId, userId, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, updatedAt = excluded.updatedAt
    RETURNING key`)
  return rows.length === 1
}

export async function deleteKv(db: DrizzleD1Database, siteId: string, userId: string, key: string) {
  await db.delete(siteKv).where(and(scope(siteId, userId), eq(siteKv.key, key)))
}
