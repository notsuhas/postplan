export function formatTimestamp(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// Timestamp prefix inserted by the composer.
export function timestampPrefix(seconds: number): string {
  return `[${formatTimestamp(seconds)}] `
}

// Splits timestamps into seek links.
export function splitTimestamps(body: string): ({ text: string } | { t: number; label: string })[] {
  const parts: ReturnType<typeof splitTimestamps> = []
  let at = 0
  for (const m of body.matchAll(/\[(\d{1,3}):([0-5]\d)\]/g)) {
    if (m.index > at) parts.push({ text: body.slice(at, m.index) })
    parts.push({ t: Number(m[1]) * 60 + Number(m[2]), label: m[0] })
    at = m.index + m[0].length
  }
  if (at < body.length) parts.push({ text: body.slice(at) })
  return parts
}
