import { describe, expect, test } from 'bun:test'
import { isOrgEmail } from './workos'

const env = { ORG_EMAIL_DOMAINS: 'headout.com, @example.org' }

describe('isOrgEmail', () => {
  test('matches configured domains case-insensitively', () => {
    expect(isOrgEmail(env, 'Person@HEADOUT.COM')).toBe(true)
    expect(isOrgEmail(env, 'person@example.org')).toBe(true)
  })

  test('requires an exact domain match', () => {
    expect(isOrgEmail(env, 'person@evilheadout.com')).toBe(false)
    expect(isOrgEmail(env, 'person@headout.com.evil.test')).toBe(false)
    expect(isOrgEmail(env, 'not-an-email')).toBe(false)
  })
})
