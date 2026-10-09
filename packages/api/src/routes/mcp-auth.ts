import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider'
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth'
import { readCredential } from '../lib/session'
import type { AppEnv } from '../types'

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
const scopeLabels: Record<string, string> = {
  'mcp:read': 'Read artifacts, source files, comments, and versions you can access.',
  'mcp:write': 'Publish and replace artifacts, reply, claim feedback, fork, roll back, and delete.',
  offline_access: 'Keep this connection signed in between sessions, for up to 30 days.',
}

function consentPage(details: ConsentDescription, handle: string, email: string): string {
  const publisher = details.clientDomain
    ? `Published by ${escapeHtml(details.clientDomain)}.`
    : 'This app registered itself. Its name is not verified.'
  const scopes = details.scope
    .map(
      (scope) =>
        `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scopeLabels[scope] ?? scope)}</label><br>`,
    )
    .join('')
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Postplan</title><body><main>
<h1>Connect ${escapeHtml(details.clientName)} to Postplan?</h1><p>Signed in as ${escapeHtml(email)}.</p>
<p>${publisher} Authorization will return to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p>Continue only if you started this connection from an app on your computer.</p>' : ''}
<form method="post" action="/api/oauth/authorize"><input type="hidden" name="handle" value="${escapeHtml(handle)}">${scopes}
<p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny">Deny</button></p></form>
<p>You can revoke access at <a href="/api/oauth/connections">MCP connections</a>.</p></main></body></html>`
}

export const mcpAuth = new Hono<AppEnv>()
mcpAuth.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  c.header('Referrer-Policy', 'no-referrer')
  if (!c.env.OAUTH_PROVIDER) return c.notFound()
  await next()
})
mcpAuth.onError((error, c) => {
  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    return c.text('This connection request is invalid or expired. Start again from your MCP client.', 400)
  }
  return c.text('Could not connect Postplan. Please try again.', 500)
})

mcpAuth.get('/authorize', async (c) => {
  const oauth = c.env.OAUTH_PROVIDER!
  const request = await oauth.parseAuthRequest(c.req.raw)
  if (request.codeChallengeMethod !== 'S256' || !request.codeChallenge) {
    return c.text('This client must use PKCE S256.', 400)
  }
  const credential = await readCredential(c)
  if (credential?.kind !== 'session') {
    const next = new URL(c.req.url)
    return c.redirect(`/login?next=${encodeURIComponent(next.pathname + next.search)}`)
  }
  const details = await oauth.describeConsent(request)
  const consent = await oauth.beginConsent(request)
  consent.headers.set('Content-Type', 'text/html; charset=utf-8')
  return new Response(consentPage(details, consent.handle, credential.user.email), { headers: consent.headers })
})

mcpAuth.post('/authorize', requireAuth, async (c) => {
  if (c.get('credential').kind !== 'session') return c.json({ error: 'browser session required' }, 403)
  const oauth = c.env.OAUTH_PROVIDER!
  const form = await c.req.formData()
  const handle = String(form.get('handle') ?? '')
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(c.req.raw, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  const approved = await oauth.approveConsent(c.req.raw, handle, { scope: form.getAll('scope').map(String) })
  const user = c.get('user')
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: encodeURIComponent(user.id),
    metadata: {},
    scope: approved.request.scope,
    props: { userId: user.id },
  })
  approved.headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers: approved.headers })
})

mcpAuth.get('/connections', requireAuth, async (c) => {
  if (c.get('credential').kind !== 'session') return c.json({ error: 'browser session required' }, 403)
  const oauth = c.env.OAUTH_PROVIDER!
  const page = await oauth.listUserGrants(encodeURIComponent(c.get('user').id), {
    limit: 100,
    cursor: c.req.query('cursor'),
  })
  const rows = await Promise.all(
    page.items.map(async (grant) => {
      const client = await oauth.lookupClient(grant.clientId)
      return `<li>${escapeHtml(client?.clientName ?? grant.clientId)} — ${escapeHtml(grant.scope.join(', '))}
<form method="post" action="/api/oauth/connections/revoke"><input type="hidden" name="grant" value="${escapeHtml(grant.id)}"><button>Revoke access</button></form></li>`
    }),
  )
  return c.html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>MCP connections</title><body><h1>MCP connections</h1><ul>${rows.join('')}</ul>${page.cursor ? `<a href="?cursor=${encodeURIComponent(page.cursor)}">Next page</a>` : ''}<p><a href="/dashboard">Back to Postplan</a></p></body></html>`,
  )
})

mcpAuth.post('/connections/revoke', requireAuth, async (c) => {
  if (c.get('credential').kind !== 'session') return c.json({ error: 'browser session required' }, 403)
  const form = await c.req.formData()
  const grant = form.get('grant')
  if (typeof grant !== 'string' || !grant || grant.length > 200) return c.text('Invalid connection.', 400)
  await c.env.OAUTH_PROVIDER!.revokeGrant(grant, encodeURIComponent(c.get('user').id))
  return c.redirect('/api/oauth/connections', 303)
})
