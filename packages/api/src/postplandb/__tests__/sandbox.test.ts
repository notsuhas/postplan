import { describe, expect, test } from 'bun:test'
import { createStorage, needsBlobDownload } from '../sandbox'

describe('createStorage — an in-memory Web Storage for sandboxed pages', () => {
  test('behaves like Storage: stringified writes, removal, clear, key, length', () => {
    const storage = createStorage()
    storage.setItem('count', 3 as unknown as string)
    expect(storage.getItem('count')).toBe('3')
    expect(storage.key(0)).toBe('count')
    expect(storage.length).toBe(1)
    storage.removeItem('count')
    expect(storage.getItem('count')).toBeNull()
    storage.setItem('a', '1')
    storage.clear()
    expect(storage.length).toBe(0)
  })

  test('named access works like the real thing', () => {
    const storage = createStorage()
    const named = storage as unknown as Record<string, string | undefined>
    named.theme = 'dark'
    expect(storage.getItem('theme')).toBe('dark')
    expect(named.theme).toBe('dark')
    expect(Object.keys(storage)).toEqual(['theme'])
    expect('theme' in storage).toBe(true)
    delete named.theme
    expect(storage.getItem('theme')).toBeNull()
  })

  test('a key named like a method still reads through getItem', () => {
    const storage = createStorage()
    storage.setItem('getItem', 'x')
    expect(typeof storage.getItem).toBe('function')
    expect(storage.getItem('getItem')).toBe('x')
  })
})

describe('needsBlobDownload — which download links the sandbox would turn into navigations', () => {
  const page = 'https://c.example/_t/tok/sp/site/index.html'
  test.each([
    ['report.csv', true],
    ['/sp/other/file.pdf', true],
    ['https://elsewhere.example/a.zip', false],
    ['data:text/plain,hi', false],
    ['blob:https://c.example/123', false],
  ])('%s → %p', (href, expected) => {
    expect(needsBlobDownload(href, page)).toBe(expected)
  })
})
