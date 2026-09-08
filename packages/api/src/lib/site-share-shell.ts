import { and, eq } from 'drizzle-orm'
import { sessionDb } from '../db/client'
import { sites, spaces } from '../db/schema'
import { signedOgImageUrl } from './og-image'
import { injectShareMetadata } from './share-meta'
import { isValidSlug } from './slug'
import type { Bindings } from '../types'

function sitePath(pathname: string): { space: string; site: string } | null {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length !== 2) return null
  try {
    const space = decodeURIComponent(parts[0])
    const site = decodeURIComponent(parts[1])
    return isValidSlug(space) && isValidSlug(site) ? { space, site } : null
  } catch {
    return null
  }
}

/** Public OG metadata is deliberately limited to unlisted sites: their URL is already the bearer. */
export async function siteShareShell(request: Request, env: Bindings): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null
  const parsed = sitePath(new URL(request.url).pathname)
  if (!parsed) return null
  const db = sessionDb(env.POSTPLAN_DB, 'first-unconstrained')
  const site = await db
    .select({ title: sites.title, description: sites.description })
    .from(sites)
    .innerJoin(spaces, eq(sites.spaceId, spaces.id))
    .where(
      and(
        eq(spaces.slug, parsed.space),
        eq(sites.slug, parsed.site),
        eq(sites.status, 'active'),
        eq(sites.visibility, 'unlisted'),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!site) return null

  const shellRequest = new Request(new URL('/index.html', request.url), { method: 'GET', headers: request.headers })
  const shellResponse = await env.ASSETS.fetch(shellRequest)
  if (!shellResponse.ok) return null
  const canonical = `${env.APP_URL}/${encodeURIComponent(parsed.space)}/${encodeURIComponent(parsed.site)}`
  const body = injectShareMetadata(await shellResponse.text(), {
    title: site.title ?? parsed.site,
    description: site.description ?? 'View and review this artifact on Postplan.',
    url: canonical,
    imageUrl: await signedOgImageUrl(env.CONTENT_TOKEN_SECRET, env.CONTENT_URL, parsed.space, parsed.site),
  })
  const headers = new Headers(shellResponse.headers)
  headers.delete('content-length')
  headers.delete('etag')
  headers.set('cache-control', 'public, max-age=60')
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers })
}
