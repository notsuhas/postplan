// window.storage: limits and the wire message, shared by the page SDK, the viewer's broker and the server.
export const KV_MAX_KEY = 200
/** UTF-8 bytes; well under D1's per-row limit. */
export const KV_MAX_VALUE_BYTES = 1_000_000

export type KvMessage =
  | { op: 'kv'; action: 'get' | 'delete'; shared: boolean; key: string }
  | { op: 'kv'; action: 'set'; shared: boolean; key: string; value: string }
  | { op: 'kv'; action: 'list'; shared: boolean; prefix: string }

// No whitespace or slashes, no control characters, and not a dot segment the URL would collapse.
const KEY_RE = /^[^\s/\\]+$/
// U+10FFFF is reserved as the upper bound of list's key range.
const hasBanned = (s: string) =>
  [...s].some((ch) => {
    const c = ch.codePointAt(0) ?? 0
    return c < 0x20 || c === 0x7f || c === 0x10ffff
  })

export function validKvKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= KV_MAX_KEY &&
    key !== '.' &&
    key !== '..' &&
    KEY_RE.test(key) &&
    !hasBanned(key)
  )
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength
