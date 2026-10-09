import { and, eq, like, ne, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { siteKv } from '../db/schema'

// Storage behind `window.storage` (the API Claude artifacts expose): string values under string keys,
// either personal to the viewer or shared by everyone who can open the site. Nothing is stored
// unless a page asks; rows go with the site.

const KV_MAX_KEY = 200
export const KV_MAX_VALUE = 1_000_000
/** Per site, all scopes, keys plus values, in characters. */
export const KV_SITE_QUOTA = 20_000_000

const KEY_RE = /^[^\s/\\]+$/

export function validKvKey(key: string): boolean {
  return key.length > 0 && key.length <= KV_MAX_KEY && KEY_RE.test(key)
}

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

/** Upsert; false when the site would go over its quota. */
export async function setKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string, value: string) {
  const [{ used }] = await db
    .select({ used: sql<number>`coalesce(sum(length(${siteKv.key}) + length(${siteKv.value})), 0)` })
    .from(siteKv)
    .where(and(eq(siteKv.siteId, siteId), or(ne(siteKv.ownerId, ownerId), ne(siteKv.key, key))))
  if (used + key.length + value.length > KV_SITE_QUOTA) return false
  const updatedAt = new Date().toISOString()
  await db
    .insert(siteKv)
    .values({ siteId, ownerId, key, value, updatedAt })
    .onConflictDoUpdate({ target: [siteKv.siteId, siteKv.ownerId, siteKv.key], set: { value, updatedAt } })
  return true
}

export async function deleteKv(db: DrizzleD1Database, siteId: string, ownerId: string, key: string) {
  await db.delete(siteKv).where(and(scope(siteId, ownerId), eq(siteKv.key, key)))
}
