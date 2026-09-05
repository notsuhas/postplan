import type { Visibility } from '../db/schema'

const VISIBILITIES: readonly Visibility[] = ['unlisted', 'private', 'members', 'team']

const SET: ReadonlySet<string> = new Set(VISIBILITIES)

export function isVisibility(v: unknown): v is Visibility {
  return typeof v === 'string' && SET.has(v)
}
