// Controls only explicitly registered timelines.

import {
  MOTION_COMMAND,
  MOTION_FPS,
  MOTION_MAX_DURATION,
  MOTION_RATES,
  MOTION_STATE,
  type MotionCommand,
} from '../../../shared/motion'

type AnyRecord = Record<string, unknown>

interface ITimeline {
  source: 'hyperframes' | 'registered'
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

interface IHyperframesPlayer {
  getDuration(): number
  getTime(): number
  seek(t: number): void
  play(): void
  pause(): void
  isPlaying(): boolean
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
    playing: () => !tl.paused() && tl.time() < Math.min(duration, tl.duration()) - END_EPSILON,
  }
}

const isHyperframesPlayer = (p: unknown): p is IHyperframesPlayer =>
  hasFns(p, ['play', 'pause', 'seek', 'getTime', 'getDuration', 'isPlaying'])

// The HyperFrames runtime's player; it has no rate control, so other speeds run on the adapter's clock.
function fromHyperframesPlayer(p: unknown): ITimeline | null {
  if (!isHyperframesPlayer(p)) return null
  const duration = p.getDuration()
  if (!okDuration(duration)) return null
  return {
    source: 'hyperframes',
    duration,
    time: () => p.getTime(),
    seek: (t) => {
      p.pause()
      p.seek(t)
    },
    play: (rate) => {
      if (rate !== 1) return false
      p.play()
      return true
    },
    pause: () => p.pause(),
    playing: () => p.isPlaying() === true,
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
  const duration = tl.duration()
  return fromGsap(tl, 'hyperframes', okDuration(declared) ? Math.min(declared, duration) : duration)
}

function detectTimeline(win: Window, doc: Document): ITimeline | null {
  const w = win as unknown as AnyRecord
  if (isGsapTimeline(w.postplanMotion)) return fromGsap(w.postplanMotion, 'registered', w.postplanMotion.duration())
  return fromHyperframesPlayer(w.__player) ?? fromHyperframesTimelines(w, doc)
}

/** Shape-check a viewer command; anything malformed is dropped. */
function parseMotionCommand(data: unknown): MotionCommand | null {
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
  raf?: (cb: () => void) => number
  cancelRaf?: (id: number) => void
}) {
  const now = opts.now ?? (() => performance.now())
  const raf = opts.raf ?? ((cb: () => void) => opts.win.requestAnimationFrame(cb))
  const cancelRaf = opts.cancelRaf ?? ((id: number) => opts.win.cancelAnimationFrame(id))
  let frame: number | null = null
  let tl: ITimeline | null = null
  let rate = 1
  let loop = false
  let playing = false
  let native = false
  let clockT = 0
  let clockAt = 0
  let lastSent = Number.NEGATIVE_INFINITY
  let lastReport: { t: number; playing: boolean } | null = null

  const clamp = (t: number) => Math.min(Math.max(t, 0), tl?.duration ?? 0)
  const current = () => {
    if (!tl) return 0
    if (!playing || native) return clamp(tl.time())
    return clamp(clockT + ((now() - clockAt) / 1000) * rate)
  }

  function report(t = current()): void {
    if (!tl) return
    if (lastReport?.t === t && lastReport.playing === playing) return
    lastReport = { t, playing }
    lastSent = now()
    opts.send({ type: MOTION_STATE, duration: tl.duration, t, playing })
  }

  function start(from: number): void {
    if (!tl) return
    tl.seek(from)
    native = tl.play(rate)
    clockT = from
    clockAt = now()
    if (!playing) {
      playing = true
      frame = raf(tick)
    }
  }

  function tick(): void {
    frame = null
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
    } else if (native && !tl.playing()) {
      playing = false
      report(t)
      return
    } else if (!native) tl.seek(t)
    if (now() - lastSent >= REPORT_MS) report()
    frame = raf(tick)
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
    if (frame !== null) cancelRaf(frame)
    frame = null
    tl.pause()
    if (!native) tl.seek(t)
    clockT = t
    report(t)
  }

  return {
    // Registered pages report once; HyperFrames starts playing.
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
        const from = current()
        rate = c.rate
        if (playing) start(from)
      } else loop = c.on
      return true
    },
  }
}
