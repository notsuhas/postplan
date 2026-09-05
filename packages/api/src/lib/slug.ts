// Flat-namespace slug rules (spec Phase 3): lowercase alphanumeric + hyphens,
// 3–40 chars, no leading/trailing hyphen. A denylist prevents slugs from shadowing
// system routes — applies to both space creation and auto-generated personal handles.

export const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'login',
  'logout',
  'dashboard',
  'content',
  'assets',
  'auth',
  'static',
  'public',
  'app',
  'www',
  'health',
  'me',
  'settings',
  'about',
  'help',
  'spaces',
  'sites',
  'upload',
  'files',
  'cli',
  'new',
  'edit',
  'delete',
  '_t',
  'whats-new',
  'docs',
])

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug)
}

/** Best-effort conversion of an email handle into a candidate personal-space slug. */
export function slugifyHandle(email: string): string {
  const handle = (email.split('@')[0] ?? 'user').toLowerCase()
  let s = handle
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length < 3) s = `${s || 'user'}-postplan`
  return s.slice(0, 40).replace(/-+$/g, '')
}

const UNLISTED_ENTROPY_BYTES = 16
const MAX_SLUG = 40

export function withUnlistedSuffix(slug: string): string {
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(UNLISTED_ENTROPY_BYTES)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const base = slug.slice(0, MAX_SLUG - suffix.length - 1).replace(/-+$/, '')
  return `${base}-${suffix}`
}

export function slugForVisibility(slug: string, visibility: unknown): string {
  return visibility === 'unlisted' ? withUnlistedSuffix(slug) : slug
}
