import { expect, test } from 'bun:test'
import { cleanDisplayText } from '../untrusted-text'

test('cleanDisplayText removes terminal controls, preserves newlines, and caps normalized text', () => {
  const escapeChar = String.fromCharCode(27)
  expect(cleanDisplayText(`  shipped${escapeChar}[2J\nclean  `, 100)).toBe('shipped[2J\nclean')
  expect(cleanDisplayText('ＡＢＣ', 2)).toBe('AB')
  expect(cleanDisplayText(`${escapeChar}`, 10)).toBeNull()
})
