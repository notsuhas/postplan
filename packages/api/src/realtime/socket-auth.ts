import type { DataCapability } from '../lib/data-token'

export type SocketAuth = { subject: string; owner: string; exp: number; caps: DataCapability[] }
export type Attached = { deserializeAttachment(): unknown }
export type Partitioned<T> = { deliver: { ws: T; auth: SocketAuth }[]; close: T[] }

export function encodeAttachment(auth: SocketAuth): SocketAuth {
  return { subject: auth.subject, owner: auth.owner, exp: auth.exp, caps: auth.caps }
}

export function decodeAttachment(raw: unknown): SocketAuth | null {
  const auth = raw as SocketAuth | null
  if (!auth || typeof auth !== 'object') return null
  if (typeof auth.subject !== 'string' || !auth.subject) return null
  if (typeof auth.owner !== 'string' || !auth.owner) return null
  if (typeof auth.exp !== 'number' || !Number.isFinite(auth.exp)) return null
  if (!Array.isArray(auth.caps)) return null
  return encodeAttachment(auth)
}

export function isAttachmentExpired(auth: SocketAuth, nowSec: number): boolean {
  return nowSec > auth.exp
}

export function partitionAuthorized<T extends Attached>(sockets: T[], siteId: string, nowSec: number): Partitioned<T> {
  const deliver: { ws: T; auth: SocketAuth }[] = []
  const close: T[] = []
  for (const ws of sockets) {
    const auth = decodeAttachment(ws.deserializeAttachment())
    if (!auth || isAttachmentExpired(auth, nowSec) || auth.owner !== siteId) close.push(ws)
    else deliver.push({ ws, auth })
  }
  return { deliver, close }
}
