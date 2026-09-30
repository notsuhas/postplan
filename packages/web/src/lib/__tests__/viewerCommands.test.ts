import { describe, expect, spyOn, test } from 'bun:test'
import {
  deepLinkReady,
  isLaidOut,
  pollUntilFound,
  railFromSearch,
  scrollCardIntoRail,
  shouldReveal,
} from '../viewerCommands'

// Slice B-wire — the viewer's remaining inline decisions, extracted so each is pinned by a test
// instead of living silently in viewer.tsx (mirrors lib/commentPopover.ts).

describe('railFromSearch — the ONLY place the deep-link URL→rail decision is made (slice C1a)', () => {
  test('the legacy `review=1` (baked into already-sent Slack/notification links) opens the rail forever', () => {
    expect(railFromSearch(new URLSearchParams('review=1'))).toBe(true)
  })

  test('no param at all does not open the rail', () => {
    expect(railFromSearch(new URLSearchParams(''))).toBe(false)
  })

  test('review=0 and any other value than the documented "1" is ignored, not truthy-coerced', () => {
    expect(railFromSearch(new URLSearchParams('review=0'))).toBe(false)
    expect(railFromSearch(new URLSearchParams('review=yes'))).toBe(false)
  })
})

describe('deepLinkReady — content-kind readiness gate for the ?thread deep link (slice C1b, kills the audio bug)', () => {
  test('audio never gets a frame load — ready as soon as its thread has arrived, loaded or not', () => {
    expect(deepLinkReady({ isMedia: true, loaded: false, hasThread: true })).toBe(true)
  })

  test('HTML must wait for the iframe onLoad even once the thread is in', () => {
    expect(deepLinkReady({ isMedia: false, loaded: false, hasThread: true })).toBe(false)
  })

  test('HTML is ready once both the frame has loaded and the thread is in', () => {
    expect(deepLinkReady({ isMedia: false, loaded: true, hasThread: true })).toBe(true)
  })

  test('neither kind reveals a thread that has not arrived yet', () => {
    expect(deepLinkReady({ isMedia: true, loaded: true, hasThread: false })).toBe(false)
    expect(deepLinkReady({ isMedia: false, loaded: true, hasThread: false })).toBe(false)
  })
})

describe('shouldReveal — reveal-request gate keyed on NONCE not id (slice C1b, kills the one-shot-per-id bug)', () => {
  test('the same thread id requested twice with a bumped nonce reveals twice', () => {
    expect(shouldReveal({ id: 't1', nonce: 1 }, 0, true)).toBe(true)
    // Simulates the rail having handled nonce 1 already, then the SAME id comes back at nonce 2.
    expect(shouldReveal({ id: 't1', nonce: 2 }, 1, true)).toBe(true)
  })

  test('an unchanged nonce across an unrelated re-render does not re-reveal', () => {
    expect(shouldReveal({ id: 't1', nonce: 1 }, 1, true)).toBe(false)
  })

  test('a different id with a bumped nonce reveals', () => {
    expect(shouldReveal({ id: 't2', nonce: 2 }, 1, true)).toBe(true)
  })

  test('no request, or a target that has not arrived, never reveals', () => {
    expect(shouldReveal(null, 1, true)).toBe(false)
    expect(shouldReveal({ id: 't1', nonce: 2 }, 1, false)).toBe(false)
  })
})

// A fake scheduler standing in for requestAnimationFrame/cancelAnimationFrame: `flush()` runs every
// pending callback (as if a frame had passed), letting these tests assert on frame COUNT without a
// real event loop or fake timers. `advanceMs` moves a fake clock alongside it, so tests can assert
// on the TIME-based budget (`maxWaitMs`) the same way — a `flush()` alone never advances the clock,
// matching real rAF frames not being evenly spaced in wall-clock time.
function fakeScheduler() {
  let nextHandle = 1
  let clockMs = 0
  const pending = new Map<number, () => void>()
  return {
    schedule: (cb: () => void) => {
      const handle = nextHandle++
      pending.set(handle, cb)
      return handle
    },
    cancel: (handle: number) => {
      pending.delete(handle)
    },
    flush: () => {
      const callbacks = [...pending.values()]
      pending.clear()
      for (const cb of callbacks) cb()
    },
    now: () => clockMs,
    advanceMs: (ms: number) => {
      clockMs += ms
    },
  }
}

describe('pollUntilFound — retries across frames instead of assuming one is enough (kills the resolved-tab silent-no-scroll bug)', () => {
  test('finds nothing on the first frame (heavier render still committing), then finds it on a later one', () => {
    const { schedule, cancel, flush, now } = fakeScheduler()
    let readyAtFrame = 2
    let frame = 0
    const applied: string[] = []
    pollUntilFound(
      () => {
        frame++
        return frame >= readyAtFrame ? 'card' : null
      },
      (found) => applied.push(found),
      schedule,
      cancel,
      2000,
      now,
    )
    flush() // frame 1: not found yet
    expect(applied).toEqual([])
    flush() // frame 2: found
    expect(applied).toEqual(['card'])
    readyAtFrame = -1 // sanity: no further scheduling happens once applied
    flush()
    expect(applied).toEqual(['card'])
  })

  test('a single frame IS still enough when the render already committed (no regression on the fast path)', () => {
    const { schedule, cancel, flush, now } = fakeScheduler()
    const applied: string[] = []
    pollUntilFound(
      () => 'card',
      (found) => applied.push(found),
      schedule,
      cancel,
      2000,
      now,
    )
    flush()
    expect(applied).toEqual(['card'])
  })

  test('keeps retrying past the old 10-frame cap as long as the time budget has not elapsed (the resolved-tab regression this replaces)', () => {
    const { schedule, cancel, flush, now, advanceMs } = fakeScheduler()
    const applied: string[] = []
    let calls = 0
    pollUntilFound(
      () => {
        calls++
        // Not found until frame 15 — past the old fixed maxAttempts=10 cap.
        return calls >= 15 ? 'card' : null
      },
      (found) => applied.push(found),
      schedule,
      cancel,
      2000,
      now,
    )
    for (let i = 0; i < 15; i++) {
      advanceMs(16) // ~one frame at 60fps, well inside the 2000ms budget
      flush()
    }
    expect(applied).toEqual(['card'])
    expect(calls).toBe(15)
  })

  test('gives up once the time budget elapses rather than polling forever for a target that never mounts', () => {
    const { schedule, cancel, flush, now, advanceMs } = fakeScheduler()
    const applied: string[] = []
    let calls = 0
    pollUntilFound(
      () => {
        calls++
        return null
      },
      (found) => applied.push(found as never),
      schedule,
      cancel,
      100,
      now,
    )
    for (let i = 0; i < 10; i++) {
      advanceMs(16)
      flush()
    }
    // Deadline (100ms) passes between the 6th and 7th tick; no further scheduling after that.
    const callsAtDeadline = calls
    for (let i = 0; i < 5; i++) flush()
    expect(calls).toBe(callsAtDeadline)
    expect(applied).toEqual([])
  })

  test('the cleanup disposer cancels a still-pending poll (effect unmount / re-run mid-flight)', () => {
    const { schedule, cancel, flush, now } = fakeScheduler()
    const applied: string[] = []
    let calls = 0
    const dispose = pollUntilFound(
      () => {
        calls++
        return null
      },
      (found) => applied.push(found as never),
      schedule,
      cancel,
      2000,
      now,
    )
    flush() // frame 1: not found, a frame-2 poll is now pending
    expect(calls).toBe(1)
    dispose() // cancel the pending frame-2 poll before it fires
    flush() // must be a no-op: nothing left pending
    expect(calls).toBe(1)
    expect(applied).toEqual([])
  })
})

describe('isLaidOut — a committed node is not yet scrollable until it has a box', () => {
  test('a 0×0 box is not laid out', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'offsetHeight', { value: 0 })
    Object.defineProperty(el, 'offsetWidth', { value: 0 })
    el.getBoundingClientRect = () =>
      ({
        width: 0,
        height: 0,
        top: 0,
        left: 0,
        bottom: 0,
        right: 0,
        x: 0,
        y: 0,
        toJSON() {
          return this
        },
      }) as DOMRect
    expect(isLaidOut(el)).toBe(false)
  })

  test('a node with a real height is laid out', () => {
    const el = document.createElement('div')
    Object.defineProperty(el, 'offsetHeight', { value: 48 })
    Object.defineProperty(el, 'offsetWidth', { value: 300 })
    expect(isLaidOut(el)).toBe(true)
  })
})

describe('scrollCardIntoRail — scroll the marked scroller, not every ancestor', () => {
  test('calls scrollTo on the data-rail-scroll ancestor, instantly, aligned to the top', () => {
    document.body.innerHTML = '<div data-rail-scroll id="scroller"><div id="card">c</div></div>'
    const scroller = document.getElementById('scroller') as HTMLElement
    const card = document.getElementById('card') as HTMLElement
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 80, writable: true })
    scroller.getBoundingClientRect = () =>
      ({ top: 100, left: 0, bottom: 500, right: 300, width: 300, height: 400, x: 0, y: 100, toJSON() {} }) as DOMRect
    card.getBoundingClientRect = () =>
      ({ top: 460, left: 0, bottom: 560, right: 300, width: 300, height: 100, x: 0, y: 460, toJSON() {} }) as DOMRect
    const spy = spyOn(scroller, 'scrollTo').mockImplementation(() => {})
    scrollCardIntoRail(card)
    expect(spy).toHaveBeenCalledWith({ top: 440, behavior: 'auto' })
    spy.mockRestore()
  })

  test('falls back to scrollIntoView at the start, instantly, when there is no marked scroller', () => {
    document.body.innerHTML = '<div id="card">c</div>'
    const card = document.getElementById('card') as HTMLElement
    const spy = spyOn(card, 'scrollIntoView').mockImplementation(() => {})
    scrollCardIntoRail(card)
    expect(spy).toHaveBeenCalledWith({ block: 'start', behavior: 'auto' })
    spy.mockRestore()
  })
})
