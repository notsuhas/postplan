import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { injectDb } from '../content'
import contentApp from '../content'
import { POSTPLAN_DB_JS } from '../postplandb/bundle'
import { signToken } from '../lib/token'
import { makeDb, makeR2, seedFile, seedSite, seedSpace, seedUser } from '../test/harness'

// postplan.db SDK injection (broker mode). The injected page gets an API surface and the app
// origin to talk to — NEVER a token, space/site pair, or any credential material.

const tokenKey = 'test-secret'

function setup() {
  const db = makeDb()
  const r2 = makeR2()
  const env = {
    APP_URL: 'https://postplan.example.com',
    CONTENT_TOKEN_SECRET: tokenKey,
    POSTPLAN_FILES: r2,
  } as unknown as Parameters<typeof contentApp.request>[2]
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('db', db)
    await next()
  })
  app.route('/', contentApp)
  return { db, r2, env, app }
}

async function gatedSite(db: ReturnType<typeof makeDb>, r2: ReturnType<typeof makeR2>, text: string) {
  const uid = await seedUser(db, { id: 'u1' })
  const sp = await seedSpace(db, { createdBy: uid, slug: 'sam' })
  const siteId = await seedSite(db, { spaceId: sp, ownerId: uid, slug: 'site', visibility: 'team' })
  await seedFile(db, r2, siteId, { path: 'index.html', text })
  return signToken(tokenKey, uid, 'sam/site', 300)
}

const HTML = '<html><head><title>Doc</title></head><body><p>Hello.</p></body></html>'

describe('postplan.db SDK asset', () => {
  test('GET /_postplan/db.js → the built client, immutable-cached', async () => {
    const { app, env } = setup()
    const res = await app.request('/_postplan/db.js', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(await res.text()).toBe(POSTPLAN_DB_JS)
  })
})

describe('postplan.db injection', () => {
  test('gated HTML + flag → boot global + sync script in <head>, before page content', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const body = await (await app.request(`/_t/${token}/sam/site/?postplan_annotate=1`, {}, env)).text()
    expect(body).toContain('window.__POSTPLAN_DB__=')
    expect(body).toContain('<script src="/_postplan/db.js')
    // Synchronous + in head: the SDK must exist before any page script runs.
    expect(body.indexOf('/_postplan/db.js')).toBeLessThan(body.indexOf('<body'))
    expect(body).not.toContain('/_postplan/db.js?v=undefined')
  })

  test('boot payload carries only the app origin and the frame nonce — no token, no site identity', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const body = await (await app.request(`/_t/${token}/sam/site/?postplan_annotate=1`, {}, env)).text()
    const boot = body.match(/window\.__POSTPLAN_DB__=(\{[^<]*?\})</)?.[1]
    expect(boot).toBeDefined()
    expect(JSON.parse(boot as string)).toEqual({ appOrigin: 'https://postplan.example.com', frameNonce: null })
  })

  test('without the flag the page only gains the SDK (in-memory localStorage)', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const body = await (await app.request(`/_t/${token}/sam/site/`, {}, env)).text()
    expect(body).toContain('window.__POSTPLAN_DB__={"appOrigin":"https://postplan.example.com","frameNonce":null}')
    expect(stripSdk(body)).toBe(HTML)
  })

  test('injectDb falls back sanely when the page has no <head>', () => {
    expect(injectDb('<body class="x"><p>hi</p></body>', 'https://a.example')).toMatch(
      /<body class="x"><script>window\.__POSTPLAN_DB__=/,
    )
    expect(injectDb('<p>bare fragment</p>', 'https://a.example')).toMatch(/^<script>window\.__POSTPLAN_DB__=/)
  })
})

function stripSdk(html: string): string {
  return html.replace(
    /<script>window\.__POSTPLAN_DB__=.*?<\/script><script src="\/_postplan\/db\.js\?v=[^"]+"><\/script>/,
    '',
  )
}

describe('sandboxed pages', () => {
  test('every served document gets an opaque origin and can still fetch its own files', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    for (const path of ['?postplan_annotate=1', '']) {
      const res = await app.request(`/_t/${token}/sam/site/${path}`, {}, env)
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain('sandbox allow-scripts')
      expect(csp).not.toContain('allow-same-origin')
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
    }
  })

  test("the viewer's nonce is echoed into both boot payloads only when it is well-formed", async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const good = 'ab'.repeat(16)
    const page = (q: string) => app.request(`/_t/${token}/sam/site/?postplan_annotate=1&postplan_frame=${q}`, {}, env)
    const body = await (await page(good)).text()
    expect(body).toContain(`window.__POSTPLAN_DB__={"appOrigin":"https://postplan.example.com","frameNonce":"${good}"}`)
    expect(body).toMatch(new RegExp(`window\\.__POSTPLAN__=\\{[^<]*"frameNonce":"${good}"\\}`))
    const bad = await (await page('%22%3E%3Cscript%3E')).text()
    expect(bad.match(/"frameNonce":null/g)).toHaveLength(2)
  })

  test('the SDK lands before any script in <head>, so page scripts already see it', () => {
    const out = injectDb('<html><head><script>localStorage.theme</script></head><body></body></html>', 'https://a')
    expect(out.indexOf('/_postplan/db.js')).toBeLessThan(out.indexOf('localStorage.theme'))
    expect(injectDb('<header>x</header>', 'https://a')).toMatch(/^<script>window\.__POSTPLAN_DB__=/)
  })

  test('plain HTML revalidates against an ETag that names the SDK version', async () => {
    const { app, db, r2, env } = setup()
    const token = await gatedSite(db, r2, HTML)
    const first = await app.request(`/_t/${token}/sam/site/`, {}, env)
    const etag = first.headers.get('etag') ?? ''
    expect(etag).toMatch(/-[0-9a-f]+"$/)
    const again = await app.request(`/_t/${token}/sam/site/`, { headers: { 'if-none-match': etag } }, env)
    expect(again.status).toBe(304)
    const stale = await app.request(
      `/_t/${token}/sam/site/`,
      { headers: { 'if-none-match': etag.replace(/-[0-9a-f]+"$/, '"') } },
      env,
    )
    expect(stale.status).toBe(200)
  })
})
