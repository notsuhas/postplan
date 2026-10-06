import { describe, expect, test } from 'bun:test'
import { isOrgEmail } from '../access-policy'

const env = { ORG_EMAIL_DOMAINS: 'company.example, @example.org' }

describe('isOrgEmail', () => {
  test('matches configured domains case-insensitively', () => {
    expect(isOrgEmail(env, 'Person@COMPANY.EXAMPLE')).toBe(true)
    expect(isOrgEmail(env, 'person@example.org')).toBe(true)
  })

  test('requires an exact domain match', () => {
    expect(isOrgEmail(env, 'person@evilcompany.example')).toBe(false)
    expect(isOrgEmail(env, 'person@company.example.evil.test')).toBe(false)
    expect(isOrgEmail(env, 'not-an-email')).toBe(false)
  })
})
