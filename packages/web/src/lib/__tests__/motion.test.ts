import { describe, expect, test } from 'bun:test'
import { createMotionStore, deriveMotionKey, stepMotion } from '../motion'

const report = { type: 'report' as const, duration: 4, t: 1, playing: true }

describe('stepMotion', () => {
  test('no timeline until the page reports one', () => {
    expect(stepMotion(null, { type: 'seek', t: 1 })).toBeNull()
    expect(stepMotion(null, report)).toEqual({ duration: 4, t: 1, playing: true, rate: 1, loop: false })
  })

  test('rate and loop survive later reports; reset drops the timeline', () => {
    let s = stepMotion(null, report)
    s = stepMotion(s, { type: 'rate', rate: 0.5 })
    s = stepMotion(s, { type: 'loop', loop: true })
    s = stepMotion(s, { ...report, t: 2 })
    expect(s).toEqual({ duration: 4, t: 2, playing: true, rate: 0.5, loop: true })
    expect(stepMotion(s, { type: 'reset' })).toBeNull()
  })

  test('a local seek clamps into the timeline', () => {
    expect(stepMotion(stepMotion(null, report), { type: 'seek', t: 10 })?.t).toBe(4)
  })
})

describe('deriveMotionKey', () => {
  const key = (k: string, target: unknown = { tagName: 'BODY' }, mods = {}) =>
    deriveMotionKey({ key: k, target, metaKey: false, ctrlKey: false, altKey: false, ...mods })

  test('space toggles and arrows step', () => {
    expect(key(' ')).toBe('toggle')
    expect(key('ArrowLeft')).toBe('back')
    expect(key('ArrowRight')).toBe('forward')
    expect(key('a')).toBeNull()
  })

  test('fields, controls and modified keys keep their own behaviour', () => {
    expect(key(' ', { tagName: 'TEXTAREA' })).toBeNull()
    expect(key(' ', { tagName: 'BUTTON' })).toBeNull()
    expect(key('ArrowLeft', { tagName: 'INPUT' })).toBeNull()
    expect(key(' ', { tagName: 'DIV', isContentEditable: true })).toBeNull()
    expect(key('ArrowLeft', undefined, { metaKey: true })).toBeNull()
  })
})

describe('createMotionStore', () => {
  test('commands go to the page and seek shows immediately', () => {
    const sent: unknown[] = []
    const store = createMotionStore((m) => sent.push(m))
    let renders = 0
    store.subscribe(() => renders++)
    store.apply(report)
    store.command({ cmd: 'seek', t: 3 })
    expect(store.get()?.t).toBe(3)
    expect(sent).toEqual([{ type: 'postplan:motion-cmd', cmd: 'seek', t: 3 }])
    expect(renders).toBe(2)
  })
})
