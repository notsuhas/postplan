import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { createMotionAdapter } from '../motion'

// motion.ts is global-free: each test builds its own happy-dom window and hangs fake timelines on it.

type AnyRecord = Record<string, unknown>

function page(html = '') {
  const win = new Window() as unknown as Window & AnyRecord
  win.document.body.innerHTML = html
  return { win, doc: win.document as unknown as Document }
}

/** A GSAP-shaped timeline whose clock only moves when the test sets it. */
function fakeTimeline(duration: number, opts: { paused?: boolean } = {}) {
  const tl = {
    t: 0,
    isPaused: opts.paused ?? false,
    scale: 1,
    duration: () => duration,
    time(t?: number) {
      if (t === undefined) return tl.t
      tl.t = t
      return tl
    },
    pause: () => {
      tl.isPaused = true
    },
    play: () => {
      tl.isPaused = false
    },
    paused: () => tl.isPaused,
    timeScale: (r: number) => {
      tl.scale = r
    },
  }
  return tl
}

describe('createMotionAdapter', () => {
  function harness(tl: ReturnType<typeof fakeTimeline>) {
    const { win, doc } = page('<div data-composition-id="root"></div>')
    win.__timelines = { root: tl }
    const sent: AnyRecord[] = []
    const frames: (() => void)[] = []
    let clock = 0
    const adapter = createMotionAdapter({
      win,
      doc,
      send: (m) => sent.push(m as AnyRecord),
      now: () => clock,
      raf: (cb) => {
        frames.push(cb)
        return frames.length
      },
      cancelRaf: () => {
        frames.length = 0
      },
    })
    const frame = (ms: number) => {
      clock += ms
      frames.shift()?.()
    }
    return { adapter, sent, frame, frames, last: () => sent.at(-1) }
  }

  test('pages without a timeline send nothing', () => {
    const { win, doc } = page()
    const sent: unknown[] = []
    const adapter = createMotionAdapter({ win, doc, send: (m) => sent.push(m), raf: () => 1 })
    expect(adapter.detect()).toBe(false)
    expect(adapter.command({ type: 'postplan:motion-cmd', cmd: 'play' })).toBe(false)
    expect(sent).toEqual([])
  })

  test('a paused HyperFrames timeline autoplays and reports its state', () => {
    const tl = fakeTimeline(2, { paused: true })
    const { adapter, last } = harness(tl)
    expect(adapter.detect()).toBe(true)
    expect(tl.isPaused).toBe(false)
    expect(last()).toEqual({ type: 'postplan:motion', duration: 2, t: 0, playing: true })
  })

  test('reports are throttled to about 10 per second while playing', () => {
    const tl = fakeTimeline(10, { paused: true })
    const { adapter, sent, frame } = harness(tl)
    adapter.detect()
    for (let i = 0; i < 30; i++) {
      tl.t += 1 / 60
      frame(1000 / 60)
    }
    expect(sent.length).toBeGreaterThanOrEqual(5)
    expect(sent.length).toBeLessThanOrEqual(7)
  })

  test('pause, seek, rate and step drive the timeline', () => {
    const tl = fakeTimeline(4, { paused: true })
    const { adapter, last } = harness(tl)
    adapter.detect()
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'pause' })
    expect(tl.isPaused).toBe(true)
    expect(last()?.playing).toBe(false)
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'seek', t: 99 })
    expect(tl.t).toBe(4)
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'seek', t: 1 })
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'step', dir: 1 })
    expect(tl.t).toBeCloseTo(1 + 1 / 30)
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'rate', rate: 0.5 })
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'play' })
    expect(tl.scale).toBe(0.5)
    expect(tl.isPaused).toBe(false)
  })

  test('duplicate reports are suppressed and pause cancels the pending frame', () => {
    const tl = fakeTimeline(4, { paused: true })
    const { adapter, sent, frames, frame } = harness(tl)
    adapter.detect()
    frame(100)
    expect(sent).toHaveLength(1)
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'pause' })
    expect(frames).toHaveLength(0)
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'pause' })
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'seek', t: 0 })
    expect(sent).toHaveLength(2)
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'play' })
    expect(frames).toHaveLength(1)
  })

  test('native playback stopping externally stops reporting and frame scheduling', () => {
    const tl = fakeTimeline(4)
    const { adapter, frames, frame, last } = harness(tl)
    adapter.detect()
    tl.isPaused = true
    frame(100)
    expect(last()?.playing).toBe(false)
    expect(frames).toHaveLength(0)
  })

  test('the end stops playback, or restarts it when looping', () => {
    const tl = fakeTimeline(1, { paused: true })
    const { adapter, frame, last } = harness(tl)
    adapter.detect()
    tl.t = 1
    frame(16)
    expect(last()).toEqual({ type: 'postplan:motion', duration: 1, t: 1, playing: false })
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'loop', on: true })
    adapter.command({ type: 'postplan:motion-cmd', cmd: 'play' })
    expect(tl.t).toBe(0)
    tl.t = 1
    frame(16)
    expect(tl.t).toBe(0)
    expect(tl.isPaused).toBe(false)
  })
})

describe('timeline registration', () => {
  test('unregistered GSAP and CSS animations are never inspected or controlled', () => {
    const { win, doc } = page()
    win.gsap = {
      get globalTimeline() {
        throw new Error('global timeline touched')
      },
      exportRoot() {
        throw new Error('exported')
      },
    }
    doc.getAnimations = () => {
      throw new Error('animations inspected')
    }
    const sent: unknown[] = []
    const adapter = createMotionAdapter({ win, doc, send: (m) => sent.push(m) })
    expect(adapter.detect()).toBe(false)
    expect(adapter.command({ type: 'postplan:motion-cmd', cmd: 'play' })).toBe(false)
    expect(sent).toEqual([])
  })

  test('explicit registration preserves a paused timeline until commanded', () => {
    const { win, doc } = page()
    const tl = fakeTimeline(3, { paused: true })
    win.postplanMotion = tl
    const sent: unknown[] = []
    const adapter = createMotionAdapter({ win, doc, send: (m) => sent.push(m), raf: () => 1 })
    expect(adapter.detect()).toBe(true)
    expect(tl.isPaused).toBe(true)
    expect(sent).toEqual([{ type: 'postplan:motion', duration: 3, t: 0, playing: false }])
    for (const fields of [
      { cmd: 'seek', t: Number.NaN },
      { cmd: 'rate', rate: 16 },
      { cmd: 'step', dir: 5 },
      { cmd: 'loop', on: 'yes' },
    ]) {
      expect(adapter.command({ type: 'postplan:motion-cmd', ...fields })).toBe(false)
    }
    expect(adapter.command({ type: 'postplan:motion-cmd', cmd: 'seek', t: 2 })).toBe(true)
    expect(tl.t).toBe(2)
  })

  test('HyperFrames bounds the root composition duration to the native timeline', () => {
    const { win, doc } = page(
      '<div data-composition-id="root" data-duration="6"><div data-composition-id="intro"></div></div>',
    )
    const root = fakeTimeline(5)
    win.__timelines = { intro: fakeTimeline(2), root }
    const sent: unknown[] = []
    const frames: (() => void)[] = []
    const adapter = createMotionAdapter({
      win,
      doc,
      send: (m) => sent.push(m),
      raf: (cb) => {
        frames.push(cb)
        return frames.length
      },
    })
    expect(adapter.detect()).toBe(true)
    expect(sent).toEqual([{ type: 'postplan:motion', duration: 5, t: 0, playing: true }])
    root.t = 5
    frames.shift()?.()
    expect(sent.at(-1)).toEqual({ type: 'postplan:motion', duration: 5, t: 5, playing: false })
    expect(frames).toHaveLength(0)
  })

  test('invalid durations do not opt into controls', () => {
    for (const duration of [0, -1, 3601, Number.POSITIVE_INFINITY, Number.NaN]) {
      const { win, doc } = page()
      win.postplanMotion = fakeTimeline(duration)
      expect(createMotionAdapter({ win, doc, send: () => {} }).detect()).toBe(false)
    }
  })
})

test('the HyperFrames player preserves elapsed time when switching between native and clock playback', () => {
  const { win, doc } = page()
  let t = 0
  let playing = false
  let clock = 0
  let tick: (() => void) | null = null
  win.__player = {
    getDuration: () => 4,
    getTime: () => t,
    isPlaying: () => playing,
    seek: (to: number) => {
      t = to
    },
    play: () => {
      playing = true
    },
    pause: () => {
      playing = false
    },
  }
  const sent: unknown[] = []
  const adapter = createMotionAdapter({
    win,
    doc,
    now: () => clock,
    send: (m) => sent.push(m),
    raf: (cb) => {
      tick = cb
      return 1
    },
  })
  expect(adapter.detect()).toBe(true)
  adapter.command({ type: 'postplan:motion-cmd', cmd: 'rate', rate: 0.5 })
  expect(playing).toBe(false)
  clock = 200
  tick?.()
  expect(t).toBeCloseTo(0.1)
  clock = 300
  adapter.command({ type: 'postplan:motion-cmd', cmd: 'rate', rate: 1 })
  expect(t).toBeCloseTo(0.15)
  expect(playing).toBe(true)
  adapter.command({ type: 'postplan:motion-cmd', cmd: 'pause' })
  expect(sent.at(-1)).toEqual({ type: 'postplan:motion', duration: 4, t: 0.15, playing: false })
})
