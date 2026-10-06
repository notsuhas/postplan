import { describe, expect, test } from 'bun:test'
import { checkRecovery } from './check-recovery'

const config = { token: 'secret', accountId: 'account', databaseId: 'database', bucket: 'files' }
const now = new Date('2026-10-06T12:00:00Z')

describe('recovery metadata check', () => {
  test('makes only authenticated metadata GETs and excludes sensitive details from the report', async () => {
    const urls: string[] = []
    const request = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      urls.push(url)
      expect(init?.method ?? 'GET').toBe('GET')
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      return Response.json({
        success: true,
        result: url.endsWith('/lock')
          ? { rules: [{ enabled: true, prefix: 'private' }, { enabled: false }] }
          : { bookmark: 'sensitive-bookmark' },
      })
    }
    const report = await checkRecovery(config, request as typeof fetch, now)
    expect(urls).toHaveLength(3)
    expect(urls.some((url) => url.includes('timestamp=2026-10-05'))).toBe(true)
    expect(report.r2.enabledLockRules).toBe(1)
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(JSON.stringify(report)).not.toContain('sensitive-bookmark')
    expect(JSON.stringify(report)).not.toContain('private')
    expect(report.independentObjectBackup).toContain('not verified')
  })

  test('fails on denied access instead of claiming backups are available', async () => {
    const request = async () => new Response('private error details', { status: 403 })
    await expect(checkRecovery(config, request as typeof fetch, now)).rejects.toThrow('failed (403)')
  })

  test('fails when a successful API response has no recovery bookmark', async () => {
    const request = async () => Response.json({ success: true, result: { rules: [] } })
    await expect(checkRecovery(config, request as typeof fetch, now)).rejects.toThrow('bookmarks are unavailable')
  })
})
