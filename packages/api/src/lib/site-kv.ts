import { and, eq, like, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { utf8Bytes } from '../../../shared/kv'
import { siteKv } from '../db/schema'

// Storage behind `window.storage` (the API Claude artifacts expose): string values under string keys,
// either personal to the viewer or shared by everyone who can open the site. Nothing is stored
// unless a page asks; rows go with the site, and personal rows with their user.

/** UTF-8 bytes of keys plus values. */
export const KV_SITE_QUOTA = 20_000_000
/** Per viewer, personal keys only, so one viewer can't fill the site. */
export const KV_OWNER_QUOTA = 5_000_000

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
  return rows.map((r) => r.key)
}

/** Upsert in ONE statement, so concurrent writes can't jointly pass the quota; false when over it. */
export async function setKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string, value: string) {
  const bytes = utf8Bytes(key) + utf8Bytes(value)
  const others = sql`siteId = ${siteId} AND NOT (ownerId = ${ownerId} AND key = ${key})`
  const rows = await db.all<{ key: string }>(sql`
    INSERT INTO site_kv (siteId, ownerId, key, value, bytes, updatedAt)
    SELECT ${siteId}, ${ownerId}, ${key}, ${value}, ${bytes}, ${new Date().toISOString()}
    WHERE (SELECT coalesce(sum(bytes), 0) FROM site_kv WHERE ${others}) + ${bytes} <= ${KV_SITE_QUOTA}
      AND (${ownerId} = '' OR (SELECT coalesce(sum(bytes), 0) FROM site_kv WHERE ${others} AND ownerId = ${ownerId}) + ${bytes} <= ${KV_OWNER_QUOTA})
    ON CONFLICT (siteId, ownerId, key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, updatedAt = excluded.updatedAt
    RETURNING key`)
  return rows.length === 1
}

export async function deleteKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string) {
  await db.delete(siteKv).where(and(scope(siteId, ownerId), eq(siteKv.key, key)))
}
