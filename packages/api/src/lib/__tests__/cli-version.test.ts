import { describe, expect, test } from 'bun:test'
import { cliNeedsUpgrade } from '../cli-version'

describe('cliNeedsUpgrade', () => {
  test('accepts the minimum version and newer releases', () => {
    expect(cliNeedsUpgrade('postplan-cli/1.2.0', '1.2.0')).toBe(false)
    expect(cliNeedsUpgrade('postplan-cli/1.3.0', '1.2.0')).toBe(false)
  })

  test('fails closed for old, missing, development, and malformed versions', () => {
    expect(cliNeedsUpgrade('postplan-cli/1.1.9', '1.2.0')).toBe(true)
    expect(cliNeedsUpgrade(undefined, '1.2.0')).toBe(true)
    expect(cliNeedsUpgrade('postplan-cli/0.0.0-dev', '1.2.0')).toBe(true)
    expect(cliNeedsUpgrade('postplan-cli/nope', '1.2.0')).toBe(true)
  })
})
