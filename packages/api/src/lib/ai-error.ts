export type AiFailure = 'quota' | 'provider'

export function classifyAiFailure(error: unknown): AiFailure {
  const value = error as { code?: unknown; message?: unknown; cause?: unknown } | null
  const text = [value?.code, value?.message, value?.cause, error].map(String).join(' ').toLowerCase()
  return text.includes('3036') || text.includes('quota') || text.includes('daily limit') ? 'quota' : 'provider'
}

export const aiFailureBody = (failure: AiFailure) =>
  failure === 'quota'
    ? ({ error: 'AI quota exhausted', code: 'ai_quota_exhausted', retryable: false } as const)
    : ({ error: 'generation failed', code: 'generation_failed', retryable: true } as const)
