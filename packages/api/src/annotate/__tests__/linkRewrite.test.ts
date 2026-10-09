import { describe, expect, test } from 'bun:test'
import { withAnnotateParam, withBrokerNonce } from '../linkRewrite'

const base = 'https://example.com/dir/index.html'

describe('withAnnotateParam — same-origin in-frame link rewrite', () => {
  test('same-origin relative link → param added', () => {
    expect(withAnnotateParam('page2.html', base)).toBe('https://example.com/dir/page2.html?postplan_annotate=1')
  })

  test('same-origin absolute link → param added', () => {
    expect(withAnnotateParam('https://example.com/other/page.html', base)).toBe(
      'https://example.com/other/page.html?postplan_annotate=1',
    )
  })

  test('cross-origin link → untouched (null)', () => {
    expect(withAnnotateParam('https://other.example/page.html', base)).toBeNull()
  })

  test('existing query + hash are preserved', () => {
    expect(withAnnotateParam('page2.html?foo=bar#section', base)).toBe(
      'https://example.com/dir/page2.html?foo=bar&postplan_annotate=1#section',
    )
  })

  test('a link that already carries the param is unchanged', () => {
    expect(withAnnotateParam('page2.html?postplan_annotate=1', base)).toBe(
      'https://example.com/dir/page2.html?postplan_annotate=1',
    )
  })

  test('an unparseable href yields null, never throws', () => {
    expect(withAnnotateParam('http://[not-valid', base)).toBeNull()
  })

  test('a protocol-relative link to another host is cross-origin → untouched', () => {
    expect(withAnnotateParam('//other.example/page.html', base)).toBeNull()
  })
})

describe('withBrokerNonce — the db nonce never leaves the site root', () => {
  const root = 'https://c.example/_t/tok/sp/site/'
  test.each([
    [
      'a page in the site keeps it',
      `${root}docs/a.html?postplan_annotate=1`,
      `${root}docs/a.html?postplan_annotate=1&postplan_broker=n`,
    ],
    [
      'another site on the same origin loses it',
      'https://c.example/sp/other/?postplan_broker=n',
      'https://c.example/sp/other/',
    ],
    ['dot segments out of the root lose it', `${root}../other/`, 'https://c.example/_t/tok/sp/other/'],
    [
      'another origin with the same path loses it',
      'https://evil.example/_t/tok/sp/site/',
      'https://evil.example/_t/tok/sp/site/',
    ],
    [
      'the site root without its slash loses it (fails safe)',
      'https://c.example/_t/tok/sp/site',
      'https://c.example/_t/tok/sp/site',
    ],
  ])('%s', (_name, href, expected) => {
    expect(withBrokerNonce(href, 'n', root)).toBe(expected)
  })

  test('no nonce on this page means none is added', () => {
    expect(withBrokerNonce(`${root}a.html`, null, root)).toBe(`${root}a.html`)
  })
})
