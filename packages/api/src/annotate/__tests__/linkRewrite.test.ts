import { describe, expect, test } from 'bun:test'
import { withAnnotateParam } from '../linkRewrite'

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

  test('broker nonce follows links within the same site', () => {
    const cur = 'https://c.example/_t/tok/sp/site/index.html?postplan_annotate=1&postplan_broker=abc'
    expect(withAnnotateParam('page2.html', cur, cur)).toBe(
      'https://c.example/_t/tok/sp/site/page2.html?postplan_annotate=1&postplan_broker=abc',
    )
  })

  test('broker nonce is stripped on links to another site on the same origin', () => {
    const cur = 'https://c.example/sp/site/index.html?postplan_annotate=1&postplan_broker=abc'
    expect(withAnnotateParam('/sp/other/', cur, cur)).toBe('https://c.example/sp/other/?postplan_annotate=1')
    expect(withAnnotateParam('/sp/other/?postplan_broker=abc', cur, cur)).toBe(
      'https://c.example/sp/other/?postplan_annotate=1',
    )
  })

  test('broker nonce comes from the document URL, not a <base href>', () => {
    const cur = 'https://c.example/sp/site/index.html?postplan_broker=abc'
    expect(withAnnotateParam('a.html', 'https://c.example/sp/site/sub/', cur)).toBe(
      'https://c.example/sp/site/sub/a.html?postplan_annotate=1&postplan_broker=abc',
    )
  })

  test('broker nonce follows a same-site link from the gated path to the public one', () => {
    const cur = 'https://c.example/_t/tok/sp/site/index.html?postplan_broker=abc'
    expect(withAnnotateParam('/sp/site/a.html', cur, cur)).toBe(
      'https://c.example/sp/site/a.html?postplan_annotate=1&postplan_broker=abc',
    )
  })

  test('broker nonce never follows an external <base href>, even with a matching path', () => {
    const cur = 'https://c.example/sp/site/index.html?postplan_broker=abc'
    expect(withAnnotateParam('a.html', 'https://evil.example/sp/site/', cur)).toBe(
      'https://evil.example/sp/site/a.html?postplan_annotate=1',
    )
  })

  test('a site root without a trailing slash fails safe (no nonce)', () => {
    const cur = 'https://c.example/sp/site/index.html?postplan_broker=abc'
    expect(withAnnotateParam('/sp/site', cur, cur)).toBe('https://c.example/sp/site?postplan_annotate=1')
  })
})
