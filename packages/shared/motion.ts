/** Page → viewer: the motion timeline's `{duration, t, playing}`, sent only by pages that have one. */
export const MOTION_STATE = 'postplan:motion'
/** Viewer → page: one playback command. */
export const MOTION_COMMAND = 'postplan:motion-cmd'
/** Upper bound on a playable timeline, in seconds; longer (or infinite) ones are ignored. */
export const MOTION_MAX_DURATION = 3600
/** Frame size for step commands. */
export const MOTION_FPS = 30
export const MOTION_RATES = [0.5, 1] as const

export type MotionCommand =
  | { cmd: 'play' }
  | { cmd: 'pause' }
  | { cmd: 'seek'; t: number }
  | { cmd: 'rate'; rate: number }
  | { cmd: 'step'; dir: 1 | -1 }
  | { cmd: 'loop'; on: boolean }
