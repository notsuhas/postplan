import { describe, expect, test } from 'bun:test'
import { aiFailureBody, classifyAiFailure } from './ai-error'

describe('AI failure classification', () => {
  test('Cloudflare quota code is terminal until the account quota resets', () => {
    const failure = classifyAiFailure({ code: 3036, message: 'daily quota exceeded' })
    expect(failure).toBe('quota')
    expect(aiFailureBody(failure)).toEqual({
      error: 'AI quota exhausted',
      code: 'ai_quota_exhausted',
      retryable: false,
    })
  })

  test('ordinary provider failures remain retryable', () => {
    const failure = classifyAiFailure(new Error('upstream unavailable'))
    expect(failure).toBe('provider')
    expect(aiFailureBody(failure)).toEqual({
      error: 'generation failed',
      code: 'generation_failed',
      retryable: true,
    })
  })
})
