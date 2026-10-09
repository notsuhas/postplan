// Motion: finds one seekable timeline on the page and plays it for the viewer's player bar.
// Global-free (window and clock are injected) so detection and commands are testable.

import {
  MOTION_COMMAND,
  MOTION_FPS,
  MOTION_MAX_DURATION,
  MOTION_RATES,
  MOTION_STATE,
  type MotionCommand,
} from '../../../shared/motion'

type AnyRecord = Record<string, unknown>

export interface ITimeline {
  source: 'hyperframes' | 'gsap' | 'waapi'
  duration: number
  time(): number
  seek(t: number): void
  /** Starts native playback; false means the adapter has to advance time itself. */
  play(rate: number): boolean
  pause(): void
  playing(): boolean
}

interface IGsapTimeline {
  duration(): number
  time(): number
  time(t: number): unknown
  pause(): unknown
  play(): unknown
  paused(): boolean
  timeScale(r: number): unknown
}

interface IGsapChild {
  endTime(includeRepeats?: boolean): number
}

const REPORT_MS = 100
const END_EPSILON = 1e-3

const isRecord = (v: unknown): v is AnyRecord => !!v && (typeof v === 'object' || typeof v === 'function')
const hasFns = (v: unknown, keys: string[]): v is AnyRecord =>
  isRecord(v) && keys.every((k) => typeof v[k] === 'function')
const okDuration = (d: unknown): d is number =>
  typeof d === 'number' && Number.isFinite(d) && d > 0 && d <= MOTION_MAX_DURATION

const isGsapTimeline = (v: unknown): v is IGsapTimeline =>
  hasFns(v, ['duration', 'time', 'pause', 'play', 'paused', 'timeScale'])

function fromGsap(tl: IGsapTimeline, source: ITimeline['source'], duration: number): ITimeline | null {
  if (!okDuration(duration)) return null
  return {
    source,
    duration,
    time: () => tl.time(),
    seek: (t) => {
      tl.pause()
      tl.time(t)
    },
    play: (rate) => {
      tl.timeScale(rate)
      tl.play()
      return true
    },
    pause: () => tl.pause(),
    playing: () => !tl.paused() && tl.time() < duration - END_EPSILON,
  }
}

// The HyperFrames runtime's player; it has no rate control, so other speeds run on the adapter's clock.
function fromHyperframesPlayer(p: unknown): ITimeline | null {
  if (!hasFns(p, ['play', 'pause', 'seek', 'getTime', 'getDuration', 'isPlaying'])) return null
  const duration = (p.getDuration as () => unknown)()
  if (!okDuration(duration)) return null
  return {
    source: 'hyperframes',
    duration,
    time: () => (p.getTime as () => number)(),
    seek: (t) => {
      ;(p.pause as () => void)()
      ;(p.seek as (t: number) => void)(t)
    },
    play: (rate) => {
      if (rate !== 1) return false
      ;(p.play as () => void)()
      return true
    },
    pause: () => (p.pause as () => void)(),
    playing: () => (p.isPlaying as () => boolean)() === true,
  }
}

// HyperFrames compositions register paused GSAP timelines by composition id; the outermost one is the video.
function fromHyperframesTimelines(win: AnyRecord, doc: Document): ITimeline | null {
  const timelines = win.__timelines
  if (!isRecord(timelines)) return null
  const root = doc.querySelector('[data-composition-id]')
  const id = root?.getAttribute('data-composition-id')
  const values = Object.values(timelines).filter(isGsapTimeline)
  const tl = id && isGsapTimeline(timelines[id]) ? timelines[id] : values.length === 1 ? values[0] : null
  if (!tl) return null
  const declared = Number(root?.getAttribute('data-duration'))
  return fromGsap(tl, 'hyperframes', okDuration(declared) ? declared : tl.duration())
}

// Plain GSAP: everything on the global timeline is wrapped into one, once every child ends.
function fromGsapGlobal(win: AnyRecord): ITimeline | null {
  const gsap = win.gsap
  if (!hasFns(gsap, ['exportRoot']) || !isRecord(gsap.globalTimeline)) return null
  const global = gsap.globalTimeline as AnyRecord
  if (typeof global.getChildren !== 'function') return null
  const children = (global.getChildren as (n: boolean, t: boolean, tl: boolean) => IGsapChild[])(false, true, true)
  if (children.length === 0) return null
  const end = Math.max(...children.map((c) => c.endTime(true)))
  if (!okDuration(end)) return null
  const tl = (gsap.exportRoot as () => unknown)()
  return isGsapTimeline(tl) ? fromGsap(tl, 'gsap', tl.duration()) : null
}

// WAAPI / CSS animations with a finite end; infinite ones (spinners) keep running untouched.
function fromAnimations(doc: Document): ITimeline | null {
  if (typeof doc.getAnimations !== 'function') return null
  const anims = doc.getAnimations().filter((a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))
  if (anims.length === 0) return null
  const endOf = (a: Animation) => Number(a.effect?.getComputedTiming().endTime) / 1000
  const longest = anims.reduce((a, b) => (endOf(b) > endOf(a) ? b : a))
  const duration = endOf(longest)
  if (!okDuration(duration)) return null
  return {
    source: 'waapi',
    duration,
    time: () => Number(longest.currentTime ?? 0) / 1000,
    seek: (t) => {
      for (const a of anims) {
        a.pause()
        a.currentTime = t * 1000
      }
    },
    play: () => false,
    pause: () => {
      for (const a of anims) a.pause()
    },
    playing: () => longest.playState === 'running',
  }
}

/** The page's one timeline, in priority order: HyperFrames, plain GSAP, then WAAPI/CSS. */
export function detectTimeline(win: Window, doc: Document): ITimeline | null {
  const w = win as unknown as AnyRecord
  return (
    fromHyperframesPlayer(w.__player) ?? fromHyperframesTimelines(w, doc) ?? fromGsapGlobal(w) ?? fromAnimations(doc)
  )
}

/** Shape-check a viewer command; anything malformed is dropped. */
export function parseMotionCommand(data: unknown): MotionCommand | null {
  if (!isRecord(data) || data.type !== MOTION_COMMAND) return null
  switch (data.cmd) {
    case 'play':
    case 'pause':
      return { cmd: data.cmd }
    case 'seek':
      return typeof data.t === 'number' && Number.isFinite(data.t) ? { cmd: 'seek', t: data.t } : null
    case 'rate':
      return (MOTION_RATES as readonly unknown[]).includes(data.rate)
        ? { cmd: 'rate', rate: data.rate as number }
        : null
    case 'step':
      return data.dir === 1 || data.dir === -1 ? { cmd: 'step', dir: data.dir } : null
    case 'loop':
      return typeof data.on === 'boolean' ? { cmd: 'loop', on: data.on } : null
    default:
      return null
  }
}

/** Owns playback of the detected timeline: native where it can, its own clock otherwise. */
export function createMotionAdapter(opts: {
  win: Window
  doc: Document
  send: (msg: unknown) => void
  now?: () => number
  raf?: (cb: () => void) => void
}) {
  const now = opts.now ?? (() => performance.now())
  const raf = opts.raf ?? ((cb: () => void) => void opts.win.requestAnimationFrame(cb))
  let tl: ITimeline | null = null
  let rate = 1
  let loop = false
  let playing = false
  let native = false
  let clockT = 0
  let clockAt = 0
  let lastSent = Number.NEGATIVE_INFINITY

  const clamp = (t: number) => Math.min(Math.max(t, 0), tl?.duration ?? 0)
  const current = () => {
    if (!tl) return 0
    if (!playing || native) return clamp(tl.time())
    return clamp(clockT + ((now() - clockAt) / 1000) * rate)
  }

  function report(t = current()): void {
    if (!tl) return
    lastSent = now()
    opts.send({ type: MOTION_STATE, duration: tl.duration, t, playing })
  }

  function start(from: number): void {
    if (!tl) return
    native = tl.play(rate)
    if (!native) tl.seek(from)
    clockT = from
    clockAt = now()
    if (!playing) {
      playing = true
      raf(tick)
    }
  }

  function tick(): void {
    if (!tl || !playing) return
    const t = current()
    if (t >= tl.duration - END_EPSILON) {
      tl.seek(loop ? 0 : tl.duration)
      if (loop) start(0)
      else {
        playing = false
        report(tl.duration)
        return
      }
    } else if (!native) tl.seek(t)
    if (now() - lastSent >= REPORT_MS) report()
    raf(tick)
  }

  function seek(t: number): void {
    if (!tl) return
    const to = clamp(t)
    tl.seek(to)
    clockT = to
    if (playing) start(to)
    report(to)
  }

  function play(): void {
    if (!tl || playing) return
    const from = current() >= tl.duration - END_EPSILON ? 0 : current()
    tl.seek(from)
    start(from)
    report(from)
  }

  function pause(): void {
    if (!tl) return
    const t = current()
    playing = false
    tl.pause()
    if (!native) tl.seek(t)
    clockT = t
    report(t)
  }

  return {
    /** Looks for a timeline once; a page that has one starts playing and reports, others stay silent. */
    detect(): boolean {
      if (tl) return true
      tl = detectTimeline(opts.win, opts.doc)
      if (!tl) return false
      const wasPlaying = tl.playing()
      const from = clamp(tl.time())
      // HyperFrames timelines are built paused; a viewer opening one expects it to play.
      if (wasPlaying || tl.source === 'hyperframes') {
        tl.seek(from)
        start(from)
      } else clockT = from
      report(from)
      return true
    },
    command(data: unknown): boolean {
      const c = parseMotionCommand(data)
      if (!c || !tl) return false
      if (c.cmd === 'play') play()
      else if (c.cmd === 'pause') pause()
      else if (c.cmd === 'seek') seek(c.t)
      else if (c.cmd === 'step') {
        if (playing) pause()
        seek(current() + c.dir / MOTION_FPS)
      } else if (c.cmd === 'rate') {
        rate = c.rate
        if (playing) start(current())
      } else loop = c.on
      return true
    },
  }
}
