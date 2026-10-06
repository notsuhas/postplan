type CloudflareResult<T> = { success: boolean; result: T }

type LockRule = { enabled: boolean; prefix?: string }

/** Read recovery metadata only; never fetch database contents, object bytes, or credentials. */
export async function checkRecovery(
  config: { token: string; accountId: string; databaseId: string; bucket: string },
  request: typeof fetch = fetch,
  now = new Date(),
) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}`
  async function get<T>(path: string): Promise<T> {
    const response = await request(`${base}${path}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Recovery metadata request failed (${response.status})`)
    const body = (await response.json()) as CloudflareResult<T>
    if (body.success !== true || !body.result) throw new Error('Cloudflare did not return recovery metadata')
    return body.result
  }
  const database = `/d1/database/${encodeURIComponent(config.databaseId)}`
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  const [current, historical, locks] = await Promise.all([
    get<{ bookmark?: string }>(`${database}/time_travel/bookmark`),
    get<{ bookmark?: string }>(`${database}/time_travel/bookmark?timestamp=${encodeURIComponent(yesterday)}`),
    get<{ rules?: LockRule[] }>(`/r2/buckets/${encodeURIComponent(config.bucket)}/lock`),
  ])
  if (!current.bookmark || !historical.bookmark) throw new Error('D1 recovery bookmarks are unavailable')
  if (!Array.isArray(locks.rules)) throw new Error('R2 lock metadata is unavailable')
  return {
    checkedAt: now.toISOString(),
    d1: { currentBookmarkAvailable: true, historicalBookmarkAvailable: true, historicalTimestamp: yesterday },
    r2: { enabledLockRules: locks.rules.filter((rule) => rule.enabled).length },
    independentObjectBackup: 'not verified by this check',
    restoreDrill: 'not performed by this check',
  }
}

if (import.meta.main) {
  const required = (name: string) => {
    const value = process.env[name]
    if (!value) throw new Error(`Missing ${name}`)
    return value
  }
  try {
    const report = await checkRecovery({
      token: required('CLOUDFLARE_API_TOKEN'),
      accountId: required('CF_ACCOUNT_ID'),
      databaseId: required('CF_D1_DATABASE_ID'),
      bucket: required('CF_R2_BUCKET'),
    })
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Recovery check failed')
    process.exitCode = 1
  }
}
