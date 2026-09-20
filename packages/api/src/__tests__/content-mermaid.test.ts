import { expect, test } from 'bun:test'
import { setup, teamSite } from '../test/content-fixtures'
import { resolveIndexPath } from '../lib/extract'

const diagram = '# Diagram\n\n```mermaid\ngraph LR\n A --> B\n```'

test('Mermaid loads locally under a fresh nonce, with and without annotation', async () => {
  const s = setup()
  const { token } = await teamSite(s, [
    { path: 'index.md', text: diagram },
    { path: 'asset.txt', text: 'asset' },
  ])
  const nonces = new Set<string>()
  for (const query of ['', '?postplan_annotate=1']) {
    const res = await s.app.request(`/_t/${token}/sp/site/${query}`, {}, s.env)
    const body = await res.text()
    expect(res.status).toBe(200)
    expect(body).toContain('<h1>Diagram</h1>')
    const nonce = /script-src 'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1]
    expect(nonce).toBeDefined()
    nonces.add(nonce!)
    expect(body).toContain(`<script nonce="${nonce}" src="/_postplan/mermaid.js?v=`)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-security-policy')).not.toContain("script-src 'self'")
    expect(body.includes('/_postplan/annotate.js')).toBe(query !== '')
  }
  expect(nonces.size).toBe(2)
})

test('raw HTML cannot opt into the renderer and ordinary code stays script-free', async () => {
  const s = setup()
  const { token } = await teamSite(s, [
    { path: 'index.md', text: '<pre><code class="language-mermaid">evil</code></pre>\n\n```js\nalert(1)\n```' },
  ])
  const res = await s.app.request(`/_t/${token}/sp/site/`, {}, s.env)
  expect(res.headers.get('content-security-policy')).toContain("script-src 'none'")
  const body = await res.text()
  expect(body).not.toContain('/_postplan/mermaid.js')
  expect(body).toContain('&lt;pre&gt;')
})

test('Markdown indexes work in nested folders and HTML takes precedence', async () => {
  const s = setup()
  const { token } = await teamSite(s, [
    { path: 'index.md', text: '# Root' },
    { path: 'docs/index.md', text: '# Nested' },
    { path: 'both/index.md', text: '# Markdown' },
    { path: 'both/index.html', text: '<h1>HTML</h1>' },
  ])
  for (const [path, title] of [
    ['', 'Root'],
    ['docs/', 'Nested'],
    ['both/', 'HTML'],
  ]) {
    const res = await s.app.request(`/_t/${token}/sp/site/${path}`, {}, s.env)
    expect(await res.text()).toContain(`<h1>${title}</h1>`)
  }
  expect(resolveIndexPath(['image.png', 'index.md'])).toBe('index.md')
  expect(resolveIndexPath(['index.md', 'index.html'])).toBe('index.html')
})

test('AVIF downloads preserve access checks, MIME type, and encoded filenames', async () => {
  const s = setup()
  const { token } = await teamSite(s, [{ path: 'a b.avif', text: 'bytes', mimeType: 'application/octet-stream' }])
  const res = await s.app.request(`/_t/${token}/sp/site/a%20b.avif?download=1`, {}, s.env)
  expect(res.headers.get('content-type')).toBe('image/avif')
  expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''a%20b.avif")
  expect(await res.text()).toBe('bytes')
  expect((await s.app.request('/sp/site/a%20b.avif?download=1', {}, s.env)).status).toBe(403)
})
