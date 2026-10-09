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
const hasControl = (s: string) => [...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)

export function validKvKey(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= KV_MAX_KEY &&
    key !== '.' &&
    key !== '..' &&
    KEY_RE.test(key) &&
    !hasControl(key)
  )
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength
