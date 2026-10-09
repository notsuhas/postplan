import { describe, expect, test, mock } from 'bun:test'
import { getUserById } from '../db/repo'
import { createSession, revokeUserAccess } from '../lib/session'
import { upload } from '../routes/upload'
import { seedSpace, seedMember, seedSite } from '../test/harness'
import { makeRouteApp, mintUser, APP_URL } from '../test/route-fixtures'

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }))
const { mcpAuth } = await import('../routes/mcp-auth')
const { createMcpOAuthProvider, fetchWithCloudMcp } = await import('./worker')

const context = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
  props: {},
} as ExecutionContext
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'
const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString(
  'base64url',
)
const cookies = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')

async function fixture(options: { minCliVersion?: string } = {}) {
  const { app, env, db, kv, r2 } = makeRouteApp()
  env.MIN_CLI_VERSION = options.minCliVersion
  await mintUser(db, kv, 'alice')
  await mintUser(db, kv, 'bob')
  const spaceId = await seedSpace(db, { slug: 'alice', createdBy: 'alice' })
  await seedMember(db, spaceId, 'alice')
  app.route('/api/upload', upload)
  app.route('/api/oauth', mcpAuth)
  app.get('/api/test/login/:user', async (c) => {
    await createSession(c, (await getUserById(db, c.req.param('user')))!)
    return c.text('ok')
  })
  const oauthKv = {
    ...kv,
    get: async (key: string, options?: { type?: string } | string) => {
      const raw = await kv.get(key)
      return raw && (options === 'json' || (typeof options === 'object' && options.type === 'json'))
        ? JSON.parse(raw)
        : raw
    },
  }
  const workerEnv = { ...env, OAUTH_KV: oauthKv as unknown as KVNamespace }
  const dispatch = (request: Request, bindings: typeof env, ctx: ExecutionContext) => app.fetch(request, bindings, ctx)
  const provider = createMcpOAuthProvider(env, dispatch, () => db)
  const send = (path: string, init?: RequestInit) =>
    provider.fetch(new Request(`${APP_URL}${path}`, init), workerEnv, context)
  const login = async (user = 'alice') => cookies((await send(`/api/test/login/${user}`)).headers)
  const client = (await (
    await send('/api/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: '<script>bad()</script>',
        redirect_uris: ['https://client.example.com/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
  ).json()) as { client_id: string }
  const authPath = (extra: Record<string, string> = {}) =>
    `/api/oauth/authorize?${new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://client.example.com/callback', response_type: 'code', scope: 'mcp:read mcp:write offline_access', state: 'state-test', resource: `${APP_URL}/api/mcp`, code_challenge: challenge, code_challenge_method: 'S256', ...extra })}`
  const consent = async (session: string) => {
    const response = await send(authPath(), { headers: { Cookie: session } })
    const html = await response.text()
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1]!
    return { html, handle, cookie: `${session}; ${cookies(response.headers)}` }
  }
  const approve = async (session: string, scope = ['mcp:read', 'mcp:write', 'offline_access']) => {
    const page = await consent(session)
    const form = new URLSearchParams({ handle: page.handle, decision: 'approve' })
    for (const item of scope) form.append('scope', item)
    const response = await send('/api/oauth/authorize', {
      method: 'POST',
      headers: { Cookie: page.cookie, Origin: APP_URL },
      body: form,
    })
    expect(response.status).toBe(302)
    const code = new URL(response.headers.get('Location')!).searchParams.get('code')!
    const tokenResponse = await send('/api/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: 'https://client.example.com/callback',
        code,
        code_verifier: verifier,
        resource: `${APP_URL}/api/mcp`,
      }),
    })
    expect(tokenResponse.status).toBe(200)
    return (await tokenResponse.json()) as { access_token: string; refresh_token: string }
  }
  const rpc = (token: string, method: string, params: unknown = {}) =>
    send('/api/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  return { ...workerEnv, send, login, client, authPath, consent, approve, rpc, db, kv, r2, spaceId }
}

describe('cloud MCP OAuth and tools', () => {
  test('discovery describes the hosted endpoint and unauthenticated requests are challenged', async () => {
    const f = await fixture()
    const challenge = await f.send('/api/mcp', { method: 'POST' })
    expect(challenge.status).toBe(401)
    expect(challenge.headers.get('WWW-Authenticate')).toContain('/.well-known/oauth-protected-resource/api/mcp')
    const resource = await (await f.send('/.well-known/oauth-protected-resource/api/mcp')).json()
    expect(resource.resource).toBe(`${APP_URL}/api/mcp`)
    const metadata = await (await f.send('/.well-known/oauth-authorization-server')).json()
    expect(metadata.authorization_endpoint).toBe(`${APP_URL}/api/oauth/authorize`)
    expect(metadata.code_challenge_methods_supported).toEqual(['S256'])
  })

  test('login preserves the validated request; consent escapes client metadata and requires S256', async () => {
    const f = await fixture()
    const loggedOut = await f.send(f.authPath())
    expect(loggedOut.status).toBe(302)
    expect(loggedOut.headers.get('Location')).toStartWith('/login?next=')
    expect((await f.send(f.authPath({ code_challenge_method: 'plain' }))).status).toBe(400)
    expect((await f.send(f.authPath({ redirect_uri: 'https://evil.example.com' }))).status).toBe(400)
    const page = await f.consent(await f.login())
    expect(page.html).toContain('&#60;script&#62;bad()&#60;/script&#62;')
    expect(page.html).toContain('client.example.com')
    expect(page.html).not.toContain('<script>bad()')
  })

  test('consent requires its browser-bound handle and same-origin session', async () => {
    const f = await fixture()
    const session = await f.login()
    const page = await f.consent(session)
    const form = new URLSearchParams({ handle: page.handle, decision: 'approve', scope: 'mcp:read' })
    expect(
      (
        await f.send('/api/oauth/authorize', {
          method: 'POST',
          headers: { Cookie: page.cookie, Origin: 'https://evil.example.com' },
          body: form,
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await f.send('/api/oauth/authorize', {
          method: 'POST',
          headers: { Cookie: session, Origin: APP_URL },
          body: form,
        })
      ).status,
    ).toBe(400)
  })

  test('HTTP initialize, tools/list, file deploy and source read work without a local CLI', async () => {
    const f = await fixture()
    const { access_token: token } = await f.approve(await f.login())
    const initialized = await (
      await f.rpc(token, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      })
    ).json()
    expect(initialized.result.protocolVersion).toBe('2025-11-25')
    const tools = await (await f.rpc(token, 'tools/list')).json()
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('deploy')
    const deployed = await (
      await f.rpc(token, 'tools/call', {
        name: 'deploy',
        arguments: {
          site: 'alice/report',
          visibility: 'private',
          files: [{ path: 'index.html', content: '<h1>Cloud</h1>' }],
          idempotency_key: 'deploy-test-1',
        },
      })
    ).json()
    expect(deployed.result.isError).toBeUndefined()
    expect(JSON.parse(deployed.result.content[0].text).siteSlug).toBe('report')
    const read = await (await f.rpc(token, 'tools/call', { name: 'read', arguments: { site: 'alice/report' } })).json()
    expect(JSON.parse(read.result.content[0].text).source).toBe('<h1>Cloud</h1>')
    expect(read.result.content[0].text).not.toContain('contentUrl')
    const replay = await (
      await f.rpc(token, 'tools/call', {
        name: 'deploy',
        arguments: {
          site: 'alice/report',
          visibility: 'private',
          files: [{ path: 'index.html', content: '<h1>Cloud</h1>' }],
          idempotency_key: 'deploy-test-1',
        },
      })
    ).json()
    expect(replay.result.content).toEqual(deployed.result.content)
    const metadata = JSON.parse(read.result.content[0].text)
    const current = await (
      await f.rpc(token, 'tools/call', {
        name: 'deploy',
        arguments: {
          site: 'alice/report',
          replace: true,
          expected_version: metadata.contentVersion,
          files: [{ path: 'index.html', content: '<h1>New</h1>' }],
          idempotency_key: 'deploy-test-2',
        },
      })
    ).json()
    expect(current.result.isError).toBeUndefined()
    const stale = await (
      await f.rpc(token, 'tools/call', {
        name: 'deploy',
        arguments: {
          site: 'alice/report',
          replace: true,
          expected_version: metadata.contentVersion,
          files: [{ path: 'index.html', content: '<h1>Stale</h1>' }],
          idempotency_key: 'deploy-test-3',
        },
      })
    ).json()
    expect(stale.result.isError).toBe(true)
    const retained = await (
      await f.rpc(token, 'tools/call', { name: 'read', arguments: { site: 'alice/report' } })
    ).json()
    expect(JSON.parse(retained.result.content[0].text).source).toBe('<h1>New</h1>')
  })

  test('read-only grants cannot mutate and another user cannot read a private artifact', async () => {
    const f = await fixture()
    await seedSite(f.db, { ownerId: 'alice', spaceId: f.spaceId, slug: 'secret', visibility: 'private' })
    const readOnly = await f.approve(await f.login(), ['mcp:read'])
    expect(readOnly.refresh_token).toBeUndefined()
    const batch = await f.send('/api/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readOnly.access_token}`,
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-11-25',
      },
      body: JSON.stringify([
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'delete', arguments: { site: 'alice/secret', confirm: true } },
        },
      ]),
    })
    expect(batch.status).toBe(400)
    expect(
      (
        await f.rpc(readOnly.access_token, 'tools/call', {
          name: 'delete',
          arguments: { site: 'alice/secret', confirm: true },
        })
      ).status,
    ).toBe(403)
    const bob = await f.approve(await f.login('bob'), ['mcp:read'])
    const response = await (
      await f.rpc(bob.access_token, 'tools/call', { name: 'read', arguments: { site: 'alice/secret' } })
    ).json()
    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).not.toContain('storageKey')
  })

  test('connection revocation and offboarding both invalidate OAuth access', async () => {
    const f = await fixture()
    const session = await f.login()
    const token = await f.approve(session)
    const response = await f.send('/api/oauth/connections', { headers: { Cookie: session } })
    const handle = /name="grant" value="([^"]+)"/.exec(await response.text())![1]!
    expect(
      (
        await f.send('/api/oauth/connections/revoke', {
          method: 'POST',
          headers: { Cookie: session, Origin: APP_URL },
          body: new URLSearchParams({ grant: handle }),
        })
      ).status,
    ).toBe(303)
    expect((await f.rpc(token.access_token, 'tools/list')).status).toBe(401)
    const fresh = await f.approve(session)
    await revokeUserAccess(f.POSTPLAN_SESSIONS, 'alice')
    expect((await f.rpc(fresh.access_token, 'tools/list')).status).toBe(401)
  })

  test('request bounds and input schemas reject local paths, traversal and accidental replacement', async () => {
    const f = await fixture()
    const token = await f.approve(await f.login())
    for (const args of [
      { path: '/Users/alice/private' },
      { site: 'alice/report', files: [{ path: '../secret', content: 'oops' }], idempotency_key: 'test-invalid' },
    ]) {
      const response = await (await f.rpc(token.access_token, 'tools/call', { name: 'deploy', arguments: args })).json()
      expect(response.result?.isError ?? Boolean(response.error)).toBe(true)
    }
    expect(
      (
        await f.send('/api/mcp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: ' '.repeat(4 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413)
  })

  test('foreign origins are rejected before authentication or tool execution', async () => {
    const f = await fixture()
    const response = await fetchWithCloudMcp(
      new Request(`${APP_URL}/api/mcp`, { headers: { Origin: 'https://evil.example.com' } }),
      f,
      context,
      () => new Response('unexpected'),
    )
    expect(response.status).toBe(403)
  })

  test('cloud uploads bypass the CLI version gate and are audited as OAuth', async () => {
    const f = await fixture({ minCliVersion: '99.0.0' })
    const token = await f.approve(await f.login())
    const response = await (
      await f.rpc(token.access_token, 'tools/call', {
        name: 'deploy',
        arguments: {
          site: 'alice/cloud-version',
          visibility: 'private',
          files: [{ path: 'index.html', content: 'cloud' }],
          idempotency_key: 'cloud-version-key',
        },
      })
    ).json()
    expect(response.result.isError).toBeUndefined()
    const { actionLedger } = await import('../db/schema')
    expect((await f.db.select().from(actionLedger))[0]?.authorization).toBe('oauth')
  })

  test('stateless HTTP refuses SSE streams and accepts initialized notifications', async () => {
    const f = await fixture()
    const token = await f.approve(await f.login())
    for (const method of ['GET', 'DELETE']) {
      const response = await f.send('/api/mcp', {
        method,
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'text/event-stream' },
      })
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
    }
    const notification = await f.send('/api/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(notification.status).toBe(202)
  })
})
