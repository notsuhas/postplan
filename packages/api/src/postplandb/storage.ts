// A Web Storage stand-in for sandboxed pages, where the real localStorage throws: an in-memory Map
// that lives as long as the page.

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

/** True when the page can't use real Web Storage (a sandboxed, opaque-origin document). */
export function storageBlocked(): boolean {
  try {
    return !window.localStorage
  } catch {
    return true
  }
}
