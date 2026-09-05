import { describe, expect, test } from 'bun:test'
import { isVisibility } from '../visibility'

describe('isVisibility', () => {
  test('accepts the four current tiers', () => {
    for (const v of ['unlisted', 'private', 'members', 'team']) expect(isVisibility(v)).toBe(true)
  })
  test('rejects obsolete tiers and junk', () => {
    expect(isVisibility('group')).toBe(false)
    expect(isVisibility('public')).toBe(false)
    expect(isVisibility('')).toBe(false)
    expect(isVisibility(undefined)).toBe(false)
  })
})
