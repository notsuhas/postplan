import { eq } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { users as usersTable } from '../db/schema'
import { sanitizeAvatarUrl, sizedAvatarUrl } from '../lib/avatar'
import { requireAuth } from '../middleware/auth'
import type { AppEnv } from '../types'

// Avatar proxy, mounted at /api/avatars. Every user photo in the UI is fetched from THIS origin —
// the stored googleusercontent URL never reaches a browser, so no viewer IP goes to Google, the
// app CSP stays `img-src 'self'`, and the <img> src keeps working when Google rotates the photo.
//
// requireAuth is load-bearing: without it this is an unauthenticated userId → photo oracle for
// anyone who can guess an id. Signed-in members are the intended audience (the directory in
// /api/users already exposes the same population).
//
// A miss (no user, no claim, disallowed host, non-image, oversized) is a 404 — the client's
// <AvatarImage> falls back to initials on any load failure, so 404 IS the fallback signal. It is
// cached briefly so a team of initials-only users doesn't re-ask on every render.

const MAX_BYTES = 2 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const HIT_CACHE = 'private, max-age=86400' // 24h: a photo change lands at the user's next login anyway
const MISS_CACHE = 'private, max-age=300'

export const avatars = new Hono<AppEnv>()

avatars.use('*', requireAuth)

avatars.get('/:userId', async (c) => {
  const row = (
    await c
      .get('db')
      .select({ avatarUrl: usersTable.avatarUrl })
      .from(usersTable)
      .where(eq(usersTable.id, c.req.param('userId')))
      .limit(1)
  )[0]

  // Re-pin at fetch time, not just at write time (see lib/avatar).
  const url = sanitizeAvatarUrl(row?.avatarUrl)
  if (!url) return miss(c)

  const upstream = await fetch(sizedAvatarUrl(url), {
    redirect: 'error',
    // cacheEverything makes Cloudflare hold the bytes at the edge; a no-op locally and in tests.
    cf: { cacheEverything: true, cacheTtl: 86400 },
  }).catch(() => null)
  if (!upstream?.ok) return miss(c)

  // Only images leave this route, and never as sniffable HTML: an origin-served document would
  // otherwise inherit the app's origin. `nosniff` is set globally in index.ts.
  const type = (upstream.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  const declaredLength = upstream.headers.get('content-length')
  if (!upstream.body || !IMAGE_TYPES.has(type)) return miss(c)
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BYTES)) return miss(c)
  const bytes = await readLimited(upstream.body)
  if (!bytes) return miss(c)

  return c.body(bytes.buffer, 200, { 'content-type': type, 'cache-control': HIT_CACHE })
})

async function readLimited(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** No photo to serve → 404, which is what makes the client render initials. */
const miss = (c: Context<AppEnv>) => c.body(null, 404, { 'cache-control': MISS_CACHE })
