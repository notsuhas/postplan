import { expect, test } from 'bun:test'
import { siteShareShell } from '../site-share-shell'

const shell = '<!doctype html><html><head><title>Postplan</title></head><body><div id="root"></div></body></html>'

test('unlisted share shell advertises its public content response', async () => {
  const statement = {
    bind: () => statement,
    raw: async () => [['Agent-readable report', 'A report an agent can follow']],
  }
  const env = {
    APP_URL: 'https://postplan.example.com',
    CONTENT_URL: 'https://content.example.com',
    CONTENT_TOKEN_SECRET: 'test-secret',
    POSTPLAN_DB: { withSession: () => ({ prepare: () => statement, getBookmark: () => null }) },
    ASSETS: { fetch: async () => new Response(shell, { headers: { 'content-type': 'text/html' } }) },
  } as never

  const res = await siteShareShell(new Request('https://postplan.example.com/acme/my-report'), env)

  expect(res?.status).toBe(200)
  expect(res?.headers.get('link')).toBe(
    '<https://content.example.com/acme/my-report/>; rel="alternate"; type="text/html"',
  )
  const body = await res?.text()
  expect(body).toContain('<h1>Agent-readable report</h1>')
  expect(body).toContain('href="https://content.example.com/acme/my-report/"')
})
