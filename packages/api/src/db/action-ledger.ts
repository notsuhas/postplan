import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { actionLedger } from './schema'

export type LedgerAction =
  | 'feedback.send'
  | 'feedback.undo'
  | 'feedback.claim'
  | 'feedback.complete'
  | 'site.publish'
  | 'site.rollback'
  | 'share.link.create'
  | 'share.link.revoke'

export async function recordAction(
  db: DrizzleD1Database,
  entry: {
    actorId: string
    action: LedgerAction
    authorization: string
    siteId?: string | null
    siteVersion?: number | null
    targetId?: string | null
    idempotencyKey?: string | null
    metadata?: Record<string, unknown> | null
  },
): Promise<void> {
  await db.insert(actionLedger).values({
    id: crypto.randomUUID(),
    actorId: entry.actorId,
    action: entry.action,
    authorization: entry.authorization,
    siteId: entry.siteId ?? null,
    siteVersion: entry.siteVersion ?? null,
    targetId: entry.targetId ?? null,
    idempotencyKey: entry.idempotencyKey ?? null,
    metadata: entry.metadata ?? null,
    createdAt: new Date().toISOString(),
  })
}
