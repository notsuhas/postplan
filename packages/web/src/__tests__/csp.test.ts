import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const headers = readFileSync(join(import.meta.dir, '../..', 'public', '_headers.example'), 'utf8')

describe('_headers CSP (G-1)', () => {
  const csp = headers.split('\n').find((l) => l.includes('Content-Security-Policy')) ?? ''
  const mediaSrc = /media-src ([^;]+);/.exec(csp)?.[1]?.trim() ?? ''

  test('declares a media-src directive', () => {
    expect(mediaSrc).not.toBe('')
  })
  test("media-src allows 'self' and blob: (local recording preview)", () => {
    expect(mediaSrc).toContain("'self'")
    expect(mediaSrc).toContain('blob:')
  })
  test('media-src carries the content-origin sentinel (same host frame-src uses)', () => {
    const frameSrc = /frame-src ([^;]+);/.exec(csp)?.[1]?.trim() ?? ''
    const contentOrigin = frameSrc.split(/\s+/).find((t) => t.startsWith('https://'))
    expect(contentOrigin).toBeTruthy()
    expect(mediaSrc).toContain(contentOrigin as string)
  })
})
