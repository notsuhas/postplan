import { describe, expect, test } from 'bun:test'
import { isValidSlug, slugForVisibility, withUnlistedSuffix } from './slug'

// `unlisted` is protected by nothing but the secrecy of its URL, and the slug IS the URL. A
// caller-supplied name is guessable by construction, so a create adds entropy.

describe('withUnlistedSuffix', () => {
  test('appends 128 bits of entropy and stays a valid slug', () => {
    const s = withUnlistedSuffix('dist')
    expect(s).toMatch(/^dist-[0-9a-f]{32}$/)
    expect(isValidSlug(s)).toBe(true)
  })

  test('is different every call', () => {
    const seen = new Set(Array.from({ length: 50 }, () => withUnlistedSuffix('dist')))
    expect(seen.size).toBe(50)
  })

  // SLUG_RE caps a slug at 40 chars, so the base has to give way to the suffix.
  test('truncates a long base rather than producing an invalid slug', () => {
    const s = withUnlistedSuffix('a'.repeat(60))
    expect(s.length).toBeLessThanOrEqual(40)
    expect(isValidSlug(s)).toBe(true)
  })

  // A base ending in '-' would otherwise yield 'name--abc123'.
  test('does not double the separator', () => {
    expect(withUnlistedSuffix('report-')).toMatch(/^report-[0-9a-f]{32}$/)
  })
})

describe('slugForVisibility', () => {
  test('only unlisted gets entropy', () => {
    expect(slugForVisibility('dist', 'unlisted')).not.toBe('dist')
    for (const v of ['team', 'private', 'members', undefined, null]) {
      expect(slugForVisibility('dist', v)).toBe('dist')
    }
  })
})
