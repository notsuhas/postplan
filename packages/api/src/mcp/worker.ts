import OAuthProvider, { insufficientScope } from '@cloudflare/workers-oauth-provider'
import type { OAuthResourceContext } from '@cloudflare/workers-oauth-provider'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { sessionDb } from '../db/client'
import { getUserById } from '../db/repo'
import { DELEGATED_USER } from '../lib/delegated-user'
import type { AppEnv, Bindings } from '../types'
import { createCloudMcpServer } from './tools'

interface IOAuthEnv extends Bindings {
  OAUTH_KV: KVNamespace
}

type Dispatch = (request: Request, env: Bindings, ctx: ExecutionContext) => Promise<Response> | Response
const MAX_REQUEST_BYTES = 4 * 1024 * 1024

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('Content-Length')) > MAX_REQUEST_BYTES) throw new RangeError()
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (length > MAX_REQUEST_BYTES) {
      await reader.cancel()
      throw new RangeError()
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
}

export function createMcpOAuthProvider(
  env: Bindings,
  dispatch: Dispatch,
  database: () => AppEnv['Variables']['db'] = () => sessionDb(env.POSTPLAN_DB, 'first-primary'),
): OAuthProvider<IOAuthEnv> {
  const origin = new URL(env.APP_URL).origin
  return new OAuthProvider<IOAuthEnv>({
    apiRoute: '/api/mcp',
    authorizeEndpoint: '/api/oauth/authorize',
    tokenEndpoint: '/api/oauth/token',
    clientRegistrationEndpoint: '/api/oauth/register',
    scopesSupported: ['mcp:read', 'mcp:write', 'offline_access'],
    requiredScopes: ['mcp:read', 'mcp:write'],
    resourceMetadata: { resource: `${origin}/api/mcp`, authorization_servers: [origin], resource_name: 'Postplan' },
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    tokenExchangeCallback: ({ scope }) => ({
      refreshTokenTTL: scope.includes('offline_access') ? 30 * 24 * 60 * 60 : 0,
    }),
    defaultHandler: { fetch: dispatch },
    apiHandler: {
      async fetch(request, oauthEnv, executionCtx) {
        if (new URL(request.url).pathname !== '/api/mcp') return new Response(null, { status: 404 })
        if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
        const ctx = executionCtx as OAuthResourceContext<{ userId: string }>
        if (!ctx.auth.scope.some((scope) => scope === 'mcp:read' || scope === 'mcp:write')) {
          return insufficientScope(ctx.auth, ['mcp:read'])
        }
        let body: unknown
        if (request.method === 'POST') {
          try {
            body = await readBody(request)
          } catch (error) {
            return Response.json(
              { error: error instanceof RangeError ? 'MCP request exceeds 4 MB.' : 'Invalid JSON.' },
              { status: error instanceof RangeError ? 413 : 400 },
            )
          }
          if (Array.isArray(body))
            return Response.json({ error: 'Batched MCP requests are unsupported.' }, { status: 400 })
        }
        if (typeof ctx.props?.userId !== 'string') return new Response(null, { status: 401 })
        const db = database()
        const user = await getUserById(db, ctx.props.userId)
        if (!user || (await oauthEnv.POSTPLAN_SESSIONS.get(`revoked_user:${user.id}`)))
          return new Response(null, { status: 401 })
        const delegatedEnv: Bindings = { ...oauthEnv, [DELEGATED_USER]: user }
        const { server, requiresWrite } = createCloudMcpServer({
          db,
          files: oauthEnv.POSTPLAN_FILES,
          canWrite: ctx.auth.scope.includes('mcp:write'),
          request: async (path, init) => dispatch(new Request(`${origin}${path}`, init), delegatedEnv, executionCtx),
        })
        const call = CallToolRequestSchema.safeParse(body)
        if (call.success && requiresWrite(call.data.params.name) && !ctx.auth.scope.includes('mcp:write')) {
          await server.close()
          return insufficientScope(ctx.auth, ['mcp:read', 'mcp:write'])
        }
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
          maxRequestBodySize: MAX_REQUEST_BYTES,
        })
        await server.connect(transport)
        try {
          const response = await transport.handleRequest(request, { parsedBody: body })
          response.headers.set('Cache-Control', 'no-store')
          return response
        } finally {
          await server.close()
        }
      },
    },
  })
}

export async function fetchWithCloudMcp(
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
  dispatch: Dispatch,
): Promise<Response> {
  const origin = request.headers.get('Origin')
  if (new URL(request.url).pathname.startsWith('/api/mcp') && origin && origin !== new URL(env.APP_URL).origin) {
    return Response.json({ error: 'Invalid origin.' }, { status: 403 })
  }
  const provider = createMcpOAuthProvider(env, dispatch)
  return provider.fetch(request, { ...env, OAUTH_KV: env.POSTPLAN_SESSIONS }, ctx)
}
