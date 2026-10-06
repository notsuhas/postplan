import { describe, expect, test } from 'bun:test'
import { safeNext } from '../packages/shared/navigation'

describe('shared login redirect policy', () => {
  test('normalizes application paths and preserves queries and fragments', () => {
    expect(safeNext('/docs/../dashboard?tab=sites#recent')).toBe('/dashboard?tab=sites#recent')
  })
  test('rejects external and normalized protocol-relative paths', () => {
    for (const value of [
      null,
      undefined,
      '',
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      '/\t/evil.test',
      '/a/..//evil.test',
    ]) {
      expect(safeNext(value)).toBeNull()
    }
  })
})
