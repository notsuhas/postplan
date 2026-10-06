import type { Context } from 'hono'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type { Bindings } from '../types'
import { fireAndForget } from './events'
import { type CacheLike, readFullObject } from './object-read'
import { decideRange } from './range'

export type ContentEnv = { Bindings: Bindings; Variables: { db?: DrizzleD1Database; caches?: { default: CacheLike } } }

// The edge cache for full-200 object reads. In the Workers runtime this is the global
// `caches.default`; bun has no global `caches` (and no `.default` on a standard CacheStorage),
// so uninjected tests resolve null and serve straight from R2 — today's exact op shape.
function getCache(c: Context<ContentEnv>): CacheLike | null {
  const injected = c.get('caches')
  if (injected) return injected.default
  const global = (globalThis as unknown as { caches?: { default?: CacheLike } }).caches
  return global?.default ?? null
}

// Full-200 reads of immutable objects live in lib/object-read (cache-fronted, tee'd warm).
// This shim owns the Hono plumbing: the request-scoped cache/bucket and the waitUntil hook.
export function readStoredObject(c: Context<ContentEnv>, storageKey: string, contentTypeHeader: string) {
  return readFullObject(getCache(c), c.env.POSTPLAN_FILES, storageKey, contentTypeHeader, (p) => fireAndForget(c, p))
}

// A 404 on the content origin must never be cached. Right after an upload a read can miss
// transiently (edge/timing); a cached 404 would then outlive the miss and strand a freshly
// published site. `no-store` keeps every not-found re-checked against live state.
export function notFound(c: Context<ContentEnv>): Response {
  return c.text('404 Not Found', 404, { 'cache-control': 'no-store' })
}

/** The storage tail of serve(): conditional (If-None-Match) handling, both Range flows (sized
 *  single-ranged-get and the legacy null-size full-get-first fallback), and the cache-fronted
 *  full-200 read — plus the HTML-only view() record and external-link rewrite. `headers`
 *  arrives pre-built (type/CSP/cache-control/accept-ranges); etag and range headers are
 *  stamped onto it here. */
export async function serveStoredObject(
  c: Context<ContentEnv>,
  args: {
    storageKey: string
    size: number | null
    etag: string | null
    headers: Headers
    rangeable: boolean
    isHtml: boolean
    mime: string
    view: () => Promise<void>
    transformHtml: (response: Response) => Response
  },
): Promise<Response> {
  const { storageKey, size, etag: rowEtag, headers, rangeable, isHtml, mime, view, transformHtml } = args

  // Honor the conditional request: when the viewer already holds this exact ETag, answer 304 and
  // skip re-streaming the body. This MUST win over Range (RFC 7233 §3.1), so it runs before any
  // Range handling. The current etag comes from D1 (denormalized at upload — storage keys are
  // immutable, so the row's etag is the object's for life): a revalidation hit costs ZERO R2 ops.
  // Legacy pre-denormalization rows (etag NULL) fall back to the old head() probe.
  const inm = c.req.header('if-none-match')
  let probedEtag: string | undefined
  if (inm !== undefined) {
    let current = rowEtag
    if (current === null) {
      const probe = await c.env.POSTPLAN_FILES.head(storageKey)
      if (!probe) return notFound(c)
      probedEtag = probe.httpEtag
      current = probe.httpEtag
    }
    if (inm === current) {
      headers.set('etag', current)
      if (isHtml) await view() // parity with the 200 path: an HTML revalidation is still a page load
      return new Response(null, { status: 304, headers })
    }
  }

  // Full 200 straight from R2, bypassing the cache — the fallout paths of a Range-carrying
  // request (multi-range / malformed spec / stale If-Range). Range requests never touch the
  // cache in either direction, so these stay off it too. decideRange may already have stamped
  // slice headers; a full body must not carry them.
  const serveFullDirect = async (): Promise<Response> => {
    headers.delete('content-range')
    headers.delete('content-length')
    const object = await c.env.POSTPLAN_FILES.get(storageKey)
    if (!object) return notFound(c)
    headers.set('etag', object.httpEtag)
    return new Response(object.body, { headers })
  }

  const rangeHeader = rangeable ? c.req.header('range') : undefined
  if (rangeHeader && size != null) {
    // D1 already told us the total (`files.size`), so the range is decided BEFORE any R2 op —
    // a satisfiable single range then costs exactly ONE ranged get, never a full one.
    // (`!= null` — a zero-byte object is a real size, not a falsy skip.)
    const ifRange = c.req.header('if-range')
    const decision = decideRange(rangeHeader, size, headers)
    if (decision.status === 416) {
      // The 416 must still carry the current etag — from D1 when denormalized, else ONE head()
      // probe, zero body bytes (reuse the If-None-Match probe's etag when it already paid).
      const etag = rowEtag ?? probedEtag ?? (await c.env.POSTPLAN_FILES.head(storageKey))?.httpEtag
      if (etag === undefined) return notFound(c)
      // A STALE If-Range means the Range no longer applies at all (RFC 7233 §3.2) → full 200.
      if (ifRange !== undefined && ifRange !== etag) return serveFullDirect()
      headers.set('etag', etag)
      return new Response(null, { status: 416, headers })
    }
    if (decision.status === 206) {
      const { start, end } = decision
      const ranged = await c.env.POSTPLAN_FILES.get(storageKey, { range: { offset: start, length: end - start + 1 } })
      if (!ranged) return notFound(c)
      // If-Range is checked against the etag the ranged get itself reports, so the matching
      // (common) case still costs a single R2 op; a stale one falls back to a full 200 (rare).
      if (ifRange !== undefined && ifRange !== ranged.httpEtag) return serveFullDirect()
      headers.set('etag', ranged.httpEtag)
      return new Response(ranged.body, { status: 206, headers })
    }
    // 'none' / 'multi' → full body (the request carried a Range header, so stay off the cache).
    return serveFullDirect()
  }
  if (rangeHeader) {
    // Legacy pre-size-column row (files.size NULL): the full get supplies total + etag first, so
    // a 206 here still costs full + ranged — today's exact shape, kept only for rare old rows.
    const object = await c.env.POSTPLAN_FILES.get(storageKey)
    if (!object) return notFound(c)
    headers.set('etag', object.httpEtag)
    const ifRange = c.req.header('if-range')
    // A stale If-Range precondition (client's cached range predates this ETag) means the Range
    // no longer applies — fall through to the full 200 body instead of a mismatched slice.
    if (!ifRange || ifRange === object.httpEtag) {
      const decision = decideRange(rangeHeader, object.size, headers)
      if (decision.status === 416) return new Response(null, { status: 416, headers })
      if (decision.status === 206) {
        const { start, end } = decision
        const ranged = await c.env.POSTPLAN_FILES.get(storageKey, { range: { offset: start, length: end - start + 1 } })
        if (!ranged) return notFound(c)
        return new Response(ranged.body, { status: 206, headers })
      }
    }
    return new Response(object.body, { headers })
  }

  // Full-200 read of an immutable object → served through the cache layer (live D1 auth already
  // ran in serve() — the cache is never consulted before the access gate).
  const read = await readStoredObject(c, storageKey, mime)
  if (!read) return notFound(c)
  headers.set('etag', read.etag)
  if (isHtml) await view()
  const res = new Response(read.body, { headers })
  // Uploaded HTML gets the streamed external-link rewrite pass. Other
  // file types (audio, images, CSS/JS, …) stream through verbatim — the rewriter only touches HTML.
  return isHtml ? transformHtml(res) : res
}
