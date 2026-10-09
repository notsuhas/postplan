// Fixes for pages running sandboxed on an opaque origin: Web Storage that doesn't throw, and
// same-site `download` links that still download.

/** A Web Storage stand-in: an in-memory Map that lives as long as the page. */
const METHODS = new Set(['getItem', 'setItem', 'removeItem', 'clear', 'key', 'length'])

export function createStorage(): Storage {
  const items = new Map<string, string>()
  const api = {
    getItem: (key: string) => items.get(String(key)) ?? null,
    setItem(key: string, value: string) {
      items.set(String(key), String(value))
    },
    removeItem(key: string) {
      items.delete(String(key))
    },
    clear() {
      items.clear()
    },
    key: (index: number) => [...items.keys()][index] ?? null,
    get length() {
      return items.size
    },
  }
  // Named access (`localStorage.theme = 'dark'`, `Object.keys(localStorage)`) behaves like the real thing.
  return new Proxy(api, {
    get: (target, prop) =>
      typeof prop === 'string' && !METHODS.has(prop) ? (items.get(prop) ?? undefined) : Reflect.get(target, prop),
    set(target, prop, value) {
      if (typeof prop !== 'string' || METHODS.has(prop)) return Reflect.set(target, prop, value)
      target.setItem(prop, value)
      return true
    },
    deleteProperty(target, prop) {
      if (typeof prop === 'string') target.removeItem(prop)
      return true
    },
    has: (target, prop) => (typeof prop === 'string' && items.has(prop)) || Reflect.has(target, prop),
    ownKeys: () => [...items.keys()],
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === 'string' && items.has(prop)
        ? { value: items.get(prop), writable: true, enumerable: true, configurable: true }
        : undefined,
  }) as unknown as Storage
}

/** True in a sandboxed, opaque-origin document, where real Web Storage throws. */
export function isSandboxed(): boolean {
  try {
    return !window.localStorage
  } catch {
    return true
  }
}

/** A link the browser would navigate instead of download: same-site, so cross-origin to the page. */
export function needsBlobDownload(href: string, pageUrl: string): boolean {
  try {
    const url = new URL(href, pageUrl)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === new URL(pageUrl).origin
  } catch {
    return false
  }
}

/** Saves a same-site file from a blob URL, which belongs to the page, so `download` is honoured. */
export async function saveViaBlob(href: string, fileName: string): Promise<void> {
  const res = await fetch(href)
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
