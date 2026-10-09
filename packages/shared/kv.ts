// Limits for `window.storage` keys and values, shared by the viewer's broker and the server.
export const KV_MAX_KEY = 200
/** UTF-8 bytes; well under D1's per-row limit. */
export const KV_MAX_VALUE_BYTES = 1_000_000

const KEY_RE = /^[^\s/\\]+$/

export function validKvKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= KV_MAX_KEY && KEY_RE.test(key)
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).byteLength
