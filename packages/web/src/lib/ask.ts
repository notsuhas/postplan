import { ApiError } from '@/lib/api'

// Streaming client for POST /api/sites/:space/:site/ask. Deliberately bypasses `api.ts`'s
// `request()` wrapper — that wrapper reads the WHOLE body via `res.json()`, which can only resolve
// once the stream ends, defeating the point of a token-by-token answer. This is a plain `fetch`
// instead, wired to the same ApiError contract so callers still get one error shape.

export type AskSite = { spaceSlug: string; siteSlug: string }
export type AskBody = { question: string; quote: string; blockText?: string }

/** Streams the answer via Workers-AI's SSE passthrough, calling `onToken` with each `.response`
 *  chunk as it arrives. Resolves once the stream ends (`data: [DONE]` or the body closes). */
export async function askStream(
  site: AskSite,
  body: AskBody,
  onToken: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/sites/${site.spaceSlug}/${site.siteSlug}/ask`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    let message = res.statusText
    let code: string | undefined
    let retryable: boolean | undefined
    try {
      const errBody = (await res.json()) as { error?: string; code?: string; retryable?: boolean }
      if (errBody?.error) message = errBody.error
      code = errBody.code
      retryable = errBody.retryable
    } catch {
      // non-JSON error body — keep statusText
    }
    throw new ApiError(res.status, message, code, retryable)
  }
  if (!res.body) throw new ApiError(502, 'AI returned no answer', 'empty_ai_response', true)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  // SSE lines can split across chunk boundaries — this carries a trailing partial line into the
  // next chunk instead of losing or mis-parsing it.
  let buffer = ''
  let tokenCount = 0

  const readLine = (line: string): boolean => {
    if (!line.startsWith('data: ')) return false
    const payload = line.slice('data: '.length)
    if (payload === '[DONE]') return true
    try {
      const parsed = JSON.parse(payload) as {
        response?: unknown
        type?: unknown
        delta?: unknown
        error?: unknown
        choices?: Array<{ delta?: { content?: unknown } }>
      }
      if (parsed.error) throw new ApiError(502, 'AI generation failed', 'generation_failed', true)
      const chat = parsed.choices?.[0]?.delta?.content
      const token =
        typeof parsed.response === 'string' && parsed.response
          ? parsed.response
          : typeof chat === 'string' && chat
            ? chat
            : parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string'
              ? parsed.delta
              : ''
      if (token) {
        tokenCount++
        onToken(token)
      }
    } catch (error) {
      if (error instanceof ApiError) throw error
    }
    return false
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? '' // last element is either '' (buffer ended on \n) or a partial line
    for (const line of lines) {
      if (readLine(line)) {
        if (tokenCount === 0) throw new ApiError(502, 'AI returned no answer', 'empty_ai_response', true)
        return
      }
    }
  }
  buffer += decoder.decode()
  if (buffer) readLine(buffer)
  if (tokenCount === 0) throw new ApiError(502, 'AI returned no answer', 'empty_ai_response', true)
}
