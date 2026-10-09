import { describe, expect, test } from 'bun:test'
import { formatTimestamp, splitTimestamps, timestampPrefix } from '../timestamp'

describe('formatTimestamp', () => {
  test('formats seconds as m:ss with zero-padded seconds', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(3)).toBe('0:03')
    expect(formatTimestamp(65.4)).toBe('1:05')
    expect(formatTimestamp(600)).toBe('10:00')
  })
  test('truncates (floors) fractional seconds, never rounds up', () => {
    expect(formatTimestamp(59.9)).toBe('0:59')
  })
  test('negative, NaN, and non-finite values clamp to 0:00', () => {
    expect(formatTimestamp(-5)).toBe('0:00')
    expect(formatTimestamp(Number.NaN)).toBe('0:00')
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})

describe('timestampPrefix', () => {
  test('wraps the formatted time in brackets with a trailing space, ready to prepend', () => {
    expect(timestampPrefix(65)).toBe('[1:05] ')
  })
})

describe('splitTimestamps', () => {
  test('splits a body around each [m:ss] into seconds', () => {
    expect(splitTimestamps('[0:03] logo pops, then [1:05] fades')).toEqual([
      { t: 3, label: '[0:03]' },
      { text: ' logo pops, then ' },
      { t: 65, label: '[1:05]' },
      { text: ' fades' },
    ])
  })
  test('leaves non-timestamps as text', () => {
    expect(splitTimestamps('see [1:75] and [x]')).toEqual([{ text: 'see [1:75] and [x]' }])
  })
})
