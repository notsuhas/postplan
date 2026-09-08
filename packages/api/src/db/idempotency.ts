import { and, eq } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { idempotencyRecords } from './schema'

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function stableRequestHash(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(value)))
}

export async function replayIdempotent(
  db: DrizzleD1Database,
  actorId: string,
  action: string,
  key: string,
  requestHash: string,
): Promise<{ kind: 'miss' } | { kind: 'conflict' } | { kind: 'replay'; statusCode: number; response: unknown }> {
  const row = await db
    .select()
    .from(idempotencyRecords)
    .where(
      and(
        eq(idempotencyRecords.actorId, actorId),
        eq(idempotencyRecords.action, action),
        eq(idempotencyRecords.key, key),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!row) return { kind: 'miss' }
  if (row.requestHash !== requestHash) return { kind: 'conflict' }
  return { kind: 'replay', statusCode: row.statusCode, response: row.response }
}

export async function storeIdempotent(
  db: DrizzleD1Database,
  actorId: string,
  action: string,
  key: string,
  requestHash: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await db.insert(idempotencyRecords).values({
    actorId,
    action,
    key,
    requestHash,
    statusCode,
    response,
    createdAt: new Date().toISOString(),
  })
}
