import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_CONTEXT, parseIntent } from '../parseIntent'

// parseIntent is a pure shape filter over data from the frame channel (which owns trust, see
// frameChannel.test.ts). These only prove obviously-bogus messages are dropped.

const validSelect = { type: 'postplan:select', quote: 'the quick brown fox' }

describe('parseIntent', () => {
  test('text context cap tracks the API storage contract', () => {
    // packages/web has no dependency/tsconfig path onto packages/api (and must not gain one — that
    // would drag worker-side code into the browser bundle), so the only way to pin this against
    // drift is to read the api's source at test time and compare the live values.
    const anchorPath = join(import.meta.dir, '../../../../api/src/lib/anchor.ts')
    const anchorSrc = readFileSync(anchorPath, 'utf8')
    const match = anchorSrc.match(/TEXT_CONTEXT_LIMIT\s*=\s*(\d+)/)
    if (!match) throw new Error(`could not find TEXT_CONTEXT_LIMIT in ${anchorPath}`)
    const apiLimit = Number(match[1])
    expect(
      MAX_CONTEXT,
      `MAX_CONTEXT (parseIntent.ts) = ${MAX_CONTEXT} must equal TEXT_CONTEXT_LIMIT (${anchorPath}) = ${apiLimit}`,
    ).toBe(apiLimit)
  })

  test('parseintent-rejects-bad-shape', () => {
    expect(parseIntent({ type: 'postplan:unknown' })).toBeNull()
    expect(parseIntent('not-an-object')).toBeNull()
    expect(parseIntent({ type: 'postplan:select' })).toBeNull() // missing quote
    expect(parseIntent({ type: 'postplan:select', quote: '' })).toBeNull() // empty quote
  })

  test('parseintent-truncates-long-select-quote', () => {
    // A selection longer than the 2000-char cap must TRUNCATE (preserving the anchor + opening the
    // composer), not be dropped — regression for #30.
    const res = parseIntent({ type: 'postplan:select', quote: 'y'.repeat(9000) })
    expect(res).toEqual({ type: 'select', quote: 'y'.repeat(2000) })
  })

  test('parseintent-accepts-valid-select', () => {
    expect(parseIntent(validSelect)).toEqual({
      type: 'select',
      quote: 'the quick brown fox',
    })
  })

  test('parses a select-clear intent', () => {
    expect(parseIntent({ type: 'postplan:select-clear' })).toEqual({ type: 'clear' })
  })

  test('parses the dismissal intents the parent cannot observe inside the iframe', () => {
    expect(parseIntent({ type: 'postplan:click-away' })).toEqual({ type: 'clickAway' })
    expect(parseIntent({ type: 'postplan:escape' })).toEqual({ type: 'escape' })
  })

  test('parses the comment-key intent (#117) — payload-free, like the dismissals', () => {
    expect(parseIntent({ type: 'postplan:comment-key' })).toEqual({ type: 'commentKey' })
  })

  test('parses the ask-key intent — payload-free, mirrors comment-key', () => {
    expect(parseIntent({ type: 'postplan:ask-key' })).toEqual({ type: 'askKey' })
  })

  test('parseintent-carries-block-text', () => {
    const res = parseIntent({ ...validSelect, blockText: 'surrounding paragraph' })
    expect(res).toMatchObject({ type: 'select', blockText: 'surrounding paragraph' })
  })

  test('parseintent-clamps-oversize-block-text', () => {
    const res = parseIntent({ ...validSelect, blockText: 'z'.repeat(9000) })
    expect((res as { blockText?: string }).blockText).toBe('z'.repeat(2000))
  })

  test('parseintent-omits-unusable-block-text', () => {
    for (const blockText of [undefined, '', 7, null, {}]) {
      const res = parseIntent({ ...validSelect, blockText })
      expect((res as { blockText?: string }).blockText).toBeUndefined()
    }
  })

  test('parseintent-carries-occurrence-context', () => {
    const res = parseIntent({ ...validSelect, context: { prefix: 'lead in ', suffix: ' tail' } })
    expect(res).toMatchObject({ type: 'select', context: { prefix: 'lead in ', suffix: ' tail' } })
  })

  test('parseintent-clamps-context-instead-of-dropping-the-selection', () => {
    // Over-cap context must not cost the comment — the side is truncated, the quote survives.
    const tail = 'quote-adjacent'
    const prefix = `${'p'.repeat(500 - tail.length)}${tail}`
    const res = parseIntent({ ...validSelect, context: { prefix, suffix: '' } })
    expect(res).toMatchObject({ type: 'select', quote: 'the quick brown fox' })
    expect((res as { context?: { prefix: string } }).context?.prefix).toBe(prefix.slice(-MAX_CONTEXT))
  })

  test('parseintent-clamps-oversize-suffix-from-the-tail-keeping-the-quote-adjacent-head', () => {
    // Suffix carries signal at its START (nearest the quote), so an over-cap suffix must clamp from
    // the opposite end — mirror of the prefix tail-clamp above, pinning the suffix's OWN clamp side.
    const head = 'quote-adjacent'
    const suffix = `${head}${'s'.repeat(500 - head.length)}`
    const res = parseIntent({ ...validSelect, context: { prefix: '', suffix } })
    expect(res).toMatchObject({ type: 'select', quote: 'the quick brown fox' })
    expect((res as { context?: { suffix: string } }).context?.suffix).toBe(suffix.slice(0, MAX_CONTEXT))
  })

  test('parseintent-omits-unusable-context', () => {
    // Absent, empty, and malformed all collapse to ONE shape (undefined) so callers never branch.
    for (const context of [undefined, {}, { prefix: '', suffix: '' }, { prefix: 7 }, 'nope', null]) {
      const res = parseIntent({ ...validSelect, context })
      expect(res).toEqual({ type: 'select', quote: 'the quick brown fox' })
    }
  })

  // Element (pinpoint) comment CREATION is dropped (slice C2a) — the parent no longer turns this
  // message into anything. A stale cached bundle may still post it (the annotate client's OWN
  // send is gone, but an old cached copy of client.ts could still be running in someone's tab); the
  // correct behaviour is for the parent to silently ignore it, not throw — so every shape of a
  // postplan:pinpoint message, well-formed or not, parses to null now.
  test('a postplan:pinpoint message (a stale cached bundle) is ignored, not parsed', () => {
    expect(
      parseIntent({
        type: 'postplan:pinpoint',
        selector: '#chart > svg',
        tag: 'svg',
        preview: 'Bar chart',
        textFallback: 'Revenue',
      }),
    ).toBeNull()
    expect(
      parseIntent({ type: 'postplan:pinpoint', selector: '#x', rect: { top: 1, left: 2, width: 3, height: 4 } }),
    ).toBeNull()
    expect(parseIntent({ type: 'postplan:pinpoint', tag: 'svg' })).toBeNull()
  })

  // The page→rail click. `id` is a thread id the parent looks up in its OWN loaded threads, so the
  // filter's whole job is shape: a string, non-empty, within the field cap.
  const anchorClick = (over: Record<string, unknown> = {}) => ({
    type: 'postplan:anchor-click',
    id: 'thread-1',
    ...over,
  })

  test('parses a well-formed anchor-click', () => {
    expect(parseIntent(anchorClick())).toEqual({ type: 'anchorClick', id: 'thread-1' })
  })

  test('anchor-click with a missing, non-string, or empty id is rejected', () => {
    for (const id of [undefined, null, 7, {}, '']) {
      expect(parseIntent(anchorClick({ id }))).toBeNull()
    }
  })

  // str()'s length cap used to be proven only by a postplan:pinpoint selector test, deleted with the
  // rest of that message type (slice C2a). Re-homed here on the field it actually still guards — an
  // id arriving from the hostile iframe — so the cap stays load-bearing, not just present.
  test('an over-cap id is rejected, not silently accepted at full length', () => {
    expect(parseIntent(anchorClick({ id: 'x'.repeat(2001) }))).toBeNull()
    expect(parseIntent(anchorClick({ id: 'x'.repeat(2000) }))).toMatchObject({
      type: 'anchorClick',
    })
  })

  test('accepts bounded anchor resolution reports', () => {
    expect(parseIntent({ type: 'postplan:pinpoint-resolved', resolved: ['t1'], orphaned: ['t2', 42] })).toEqual({
      type: 'anchorStatus',
      resolved: ['t1'],
      orphaned: ['t2'],
    })
  })

  test('accepts a ready handshake', () => {
    expect(parseIntent({ type: 'postplan:ready', filePath: 'index.html' })).toEqual({
      type: 'ready',
      filePath: 'index.html',
    })
  })

  test('a ready handshake with an over-cap filePath is rejected, not truncated', () => {
    // Unlike the select quote (truncated, so a long selection still opens the composer), `str()`
    // rejects outright — a truncated filePath would misattribute comments to a path that doesn't exist.
    expect(parseIntent({ type: 'postplan:ready', filePath: 'x'.repeat(2001) })).toBeNull()
  })

  test('a motion report is accepted with t clamped into the timeline', () => {
    expect(parseIntent({ type: 'postplan:motion', duration: 4, t: 9, playing: true })).toEqual({
      type: 'motion',
      duration: 4,
      t: 4,
      playing: true,
    })
  })

  test('a motion report with a bad duration, time or flag is dropped', () => {
    const ok = { type: 'postplan:motion', duration: 4, t: 1, playing: false }
    expect(parseIntent({ ...ok, duration: 0 })).toBeNull()
    expect(parseIntent({ ...ok, duration: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseIntent({ ...ok, t: Number.NaN })).toBeNull()
    expect(parseIntent({ ...ok, playing: 'yes' })).toBeNull()
  })
})
