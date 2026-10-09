import { describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { createMotionAdapter, detectTimeline, parseMotionCommand } from '../motion'

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

describe('detectTimeline', () => {
  test('a page with no animation has no timeline', () => {
    const { win, doc } = page('<p>static</p>')
    expect(detectTimeline(win, doc)).toBeNull()
  })

  test('HyperFrames: the outermost composition timeline wins, sized by its data-duration', () => {
    const { win, doc } = page(
      '<div data-composition-id="root" data-duration="6"><div data-composition-id="intro"></div></div>',
    )
    win.__timelines = { intro: fakeTimeline(2), root: fakeTimeline(5) }
    const tl = detectTimeline(win, doc)
    expect(tl?.source).toBe('hyperframes')
    expect(tl?.duration).toBe(6)
  })

  test('HyperFrames: a lone registered timeline is used even without a matching id', () => {
    const { win, doc } = page()
    win.__timelines = { scene: fakeTimeline(4) }
    expect(detectTimeline(win, doc)?.duration).toBe(4)
  })

  test('the HyperFrames runtime player is preferred when present', () => {
    const { win, doc } = page()
    win.__timelines = { scene: fakeTimeline(4) }
    win.__player = {
      play() {},
      pause() {},
      seek() {},
      getTime: () => 0,
      getDuration: () => 8,
      isPlaying: () => false,
    }
    const tl = detectTimeline(win, doc)
    expect(tl?.source).toBe('hyperframes')
    expect(tl?.duration).toBe(8)
    expect(tl?.play(0.5)).toBe(false)
  })

  test('plain GSAP: the global timeline is exported once every child ends', () => {
    const { win, doc } = page()
    const exported = fakeTimeline(3)
    win.gsap = {
      globalTimeline: { getChildren: () => [{ endTime: () => 1 }, { endTime: () => 3 }] },
      exportRoot: () => exported,
    }
    const tl = detectTimeline(win, doc)
    expect(tl?.source).toBe('gsap')
    expect(tl?.duration).toBe(3)
  })

  test('plain GSAP with an infinite repeat is not a timeline', () => {
    const { win, doc } = page()
    let exported = false
    win.gsap = {
      globalTimeline: { getChildren: () => [{ endTime: () => 1e10 }] },
      exportRoot: () => {
        exported = true
        return fakeTimeline(1)
      },
    }
    expect(detectTimeline(win, doc)).toBeNull()
    expect(exported).toBe(false)
  })

  test('WAAPI: finite animations form a timeline as long as the longest one', () => {
    const { win, doc } = page()
    const anim = (end: number) => ({
      effect: { getComputedTiming: () => ({ endTime: end }) },
      currentTime: 0,
      playState: 'running',
      pause() {},
    })
    doc.getAnimations = () => [anim(1000), anim(2500), anim(Number.POSITIVE_INFINITY)] as unknown as Animation[]
    const tl = detectTimeline(win, doc)
    expect(tl?.source).toBe('waapi')
    expect(tl?.duration).toBe(2.5)
  })
})

describe('parseMotionCommand', () => {
  const cmd = (fields: AnyRecord) => parseMotionCommand({ type: 'postplan:motion-cmd', ...fields })

  test('accepts each well-formed command', () => {
    expect(cmd({ cmd: 'play' })).toEqual({ cmd: 'play' })
    expect(cmd({ cmd: 'pause' })).toEqual({ cmd: 'pause' })
    expect(cmd({ cmd: 'seek', t: 1.5 })).toEqual({ cmd: 'seek', t: 1.5 })
    expect(cmd({ cmd: 'rate', rate: 0.5 })).toEqual({ cmd: 'rate', rate: 0.5 })
    expect(cmd({ cmd: 'step', dir: -1 })).toEqual({ cmd: 'step', dir: -1 })
    expect(cmd({ cmd: 'loop', on: true })).toEqual({ cmd: 'loop', on: true })
  })

  test('rejects wrong types, unknown commands and bad fields', () => {
    expect(parseMotionCommand(null)).toBeNull()
    expect(parseMotionCommand({ type: 'postplan:paint', cmd: 'play' })).toBeNull()
    expect(cmd({ cmd: 'eval' })).toBeNull()
    expect(cmd({ cmd: 'seek', t: '1' })).toBeNull()
    expect(cmd({ cmd: 'seek', t: Number.NaN })).toBeNull()
    expect(cmd({ cmd: 'rate', rate: 16 })).toBeNull()
    expect(cmd({ cmd: 'step', dir: 5 })).toBeNull()
    expect(cmd({ cmd: 'loop', on: 'yes' })).toBeNull()
  })
})

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
      raf: (cb) => frames.push(cb),
    })
    const frame = (ms: number) => {
      clock += ms
      frames.shift()?.()
    }
    return { adapter, sent, frame, last: () => sent.at(-1) }
  }

  test('pages without a timeline send nothing', () => {
    const { win, doc } = page()
    const sent: unknown[] = []
    const adapter = createMotionAdapter({ win, doc, send: (m) => sent.push(m), raf: () => {} })
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
