// Viewer side of motion playback: the player bar's state, fed by page reports and its own commands.
import { MOTION_COMMAND, type MotionCommand } from '../../../shared/motion'

interface IMotionState {
  duration: number
  t: number
  playing: boolean
  rate: number
  loop: boolean
}

type MotionEvent =
  | { type: 'report'; duration: number; t: number; playing: boolean }
  | { type: 'reset' }
  | { type: 'seek'; t: number }
  | { type: 'rate'; rate: number }
  | { type: 'loop'; loop: boolean }

/** Null until the page reports a timeline; rate and loop are viewer-owned and survive reports. */
function stepMotion(state: IMotionState | null, event: MotionEvent): IMotionState | null {
  switch (event.type) {
    case 'report':
      if (state?.duration === event.duration && state.t === event.t && state.playing === event.playing) return state
      return {
        rate: state?.rate ?? 1,
        loop: state?.loop ?? false,
        duration: event.duration,
        t: event.t,
        playing: event.playing,
      }
    case 'reset':
      return null
    case 'seek':
      return state && { ...state, t: Math.min(Math.max(event.t, 0), state.duration) }
    case 'rate':
      return state && { ...state, rate: event.rate }
    case 'loop':
      return state && { ...state, loop: event.loop }
  }
}

export function deriveMotionKey(
  e: Pick<
    KeyboardEvent,
    'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'defaultPrevented' | 'isComposing' | 'target'
  >,
): 'toggle' | 'back' | 'forward' | null {
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null
  const el = e.target
  if (
    !(el instanceof HTMLElement) ||
    el.tagName !== 'BODY' ||
    el.isContentEditable ||
    el.closest('[contenteditable], [role]')
  )
    return null
  if (e.key === ' ') return 'toggle'
  if (e.key === 'ArrowLeft') return 'back'
  if (e.key === 'ArrowRight') return 'forward'
  return null
}

/** One store per viewer mount, so a playing timeline re-renders the bar and not the whole viewer. */
export function createMotionStore(send: (msg: unknown) => void) {
  let state: IMotionState | null = null
  const listeners = new Set<() => void>()
  const apply = (event: MotionEvent) => {
    const next = stepMotion(state, event)
    if (next === state) return
    state = next
    for (const l of listeners) l()
  }
  return {
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    apply,
    /** Sends a command; seek, rate and loop show immediately rather than on the next report. */
    command(c: MotionCommand) {
      if (c.cmd === 'seek') apply({ type: 'seek', t: c.t })
      else if (c.cmd === 'rate') apply({ type: 'rate', rate: c.rate })
      else if (c.cmd === 'loop') apply({ type: 'loop', loop: c.on })
      send({ type: MOTION_COMMAND, ...c })
    },
  }
}

export type MotionStore = ReturnType<typeof createMotionStore>
