import { describe, expect, test } from 'bun:test'
import { versionDiff } from '../siteVersions'

describe('versionDiff', () => {
  test('separates added, removed, and changed paths', () => {
    const from = [
      { path: 'index.html', size: 10, etag: 'a' },
      { path: 'old.css', size: 5, etag: 'b' },
    ]
    const to = [
      { path: 'index.html', size: 12, etag: 'c' },
      { path: 'new.css', size: 5, etag: 'd' },
    ]
    expect(versionDiff(from, to)).toEqual({
      added: ['new.css'],
      removed: ['old.css'],
      changed: ['index.html'],
    })
  })
})
