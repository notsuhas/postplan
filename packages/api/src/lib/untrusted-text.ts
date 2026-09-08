/** Remove terminal-active ASCII controls while preserving ordinary multiline text. */
export function cleanDisplayText(value: string, maxLength: number): string | null {
  let cleaned = ''
  for (const char of value.normalize('NFKC')) {
    const code = char.charCodeAt(0)
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue
    cleaned += char
    if (cleaned.length >= maxLength) break
  }
  return cleaned.slice(0, maxLength).trim() || null
}
