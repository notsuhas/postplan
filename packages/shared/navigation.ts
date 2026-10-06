/** Root-relative paths only — blocks protocol-relative (`//evil.com`) and `/\evil.com`. */
export function safeNext(next: string | null | undefined): string | null {
  if (typeof next !== 'string') return null
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return null
  // URL parsing removes tabs/newlines and normalizes backslashes; check the resulting origin too.
  try {
    const url = new URL(next, 'https://postplan.invalid')
    if (url.origin !== 'https://postplan.invalid' || url.pathname.startsWith('//')) return null
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return null
  }
}
