import type { Visibility } from '../db/schema'

// Single source of truth for the visibility tiers accepted on the wire. Shared by the create,
// upload, update, and admin-filter paths so the accepted set never drifts between them.
export const VISIBILITIES: readonly Visibility[] = ['unlisted', 'private', 'members', 'team']

const SET: ReadonlySet<string> = new Set(VISIBILITIES)

// Legacy tiers are mapped onto their replacements before validating — never reject a legacy value,
// just normalize it. `group` → `members` (renamed; the word collided with space *type* and the
// share-modal's group picker). `public` → `unlisted`: an anonymous tier exists again, and
// `unlisted` is what `public` always meant here — anyone holding the URL, nothing listed anywhere.
export function normalizeVisibility(v: unknown): unknown {
  if (v === 'group') return 'members'
  if (v === 'public') return 'unlisted'
  return v
}

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === 'string' && SET.has(v)
}
