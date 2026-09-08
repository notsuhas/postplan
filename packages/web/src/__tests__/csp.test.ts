import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const headers = readFileSync(join(import.meta.dir, '../..', 'public', '_headers.example'), 'utf8')
const indexHtml = readFileSync(join(import.meta.dir, '../..', 'index.html'), 'utf8')

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
  test('allows the exact pre-paint theme script so a saved light theme survives refresh', () => {
    const script = indexHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    const hash = createHash('sha256')
      .update(script as string)
      .digest('base64')
    expect(csp).toContain(`'sha256-${hash}'`)
  })
})
