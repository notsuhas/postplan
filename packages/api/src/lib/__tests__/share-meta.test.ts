import { describe, expect, test } from 'bun:test'
import { injectShareMetadata } from '../share-meta'

const shell = `<!doctype html><html><head>
<title>Postplan — Artifacts for every agent</title>
<meta name="description" content="generic">
<meta property="og:title" content="generic title">
<meta property="og:description" content="generic description">
</head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`

describe('injectShareMetadata', () => {
  test('describes the shared artifact and preserves the SPA shell', () => {
    const html = injectShareMetadata(shell, {
      title: 'Remote Cloud & Codex sessions with Herdr',
      description: 'Installation and remote login steps',
      url: 'https://postplan.example.com/suhas/herdr-r-49bd',
      imageUrl: 'https://content.example.com/_postplan/og/suhas/herdr-r-49bd.png?sig=abc',
    })
    expect(html).toContain('<title>Remote Cloud &amp; Codex sessions with Herdr · Postplan</title>')
    expect(html).toContain('property="og:title" content="Remote Cloud &amp; Codex sessions with Herdr"')
    expect(html).toContain('property="og:description" content="Installation and remote login steps"')
    expect(html).toContain('property="og:url" content="https://postplan.example.com/suhas/herdr-r-49bd"')
    expect(html).toContain(
      'property="og:image" content="https://content.example.com/_postplan/og/suhas/herdr-r-49bd.png?sig=abc"',
    )
    expect(html).toContain('rel="canonical" href="https://postplan.example.com/suhas/herdr-r-49bd"')
    expect(html).toContain('src="/assets/app.js"')
    expect(html).not.toContain('content="generic title"')
  })

  test('escapes stored metadata instead of trusting uploaded text', () => {
    const html = injectShareMetadata(shell, {
      title: '"><script>alert(1)</script>',
      description: '<img src=x onerror=alert(1)>',
      url: 'https://postplan.example.com/a/b',
      imageUrl: 'https://content.example.com/card.png',
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})
