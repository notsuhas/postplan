import { describe, expect, test } from 'bun:test'
import { createMotionStore, deriveMotionKey } from '../motion'

const report = { type: 'report' as const, duration: 4, t: 1, playing: true }

describe('deriveMotionKey', () => {
  const key = (k: string, target: EventTarget = document.body, mods = {}) =>
    deriveMotionKey({
      key: k,
      target,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      defaultPrevented: false,
      isComposing: false,
      ...mods,
    })
  const element = (tag: string) => document.createElement(tag)

  test('space toggles and arrows step', () => {
    expect(key(' ')).toBe('toggle')
    expect(key('ArrowLeft')).toBe('back')
    expect(key('ArrowRight')).toBe('forward')
    expect(key('a')).toBeNull()
  })

  test('fields, controls and modified keys keep their own behaviour', () => {
    expect(key(' ', element('textarea'))).toBeNull()
    expect(key(' ', element('button'))).toBeNull()
    expect(key('ArrowLeft', element('input'))).toBeNull()
    expect(key(' ', element('div'))).toBeNull()
    expect(key('ArrowLeft', undefined, { metaKey: true })).toBeNull()
    expect(key(' ', undefined, { defaultPrevented: true })).toBeNull()
    expect(key(' ', undefined, { isComposing: true })).toBeNull()
    const widget = element('div')
    widget.setAttribute('role', 'tab')
    expect(key('ArrowRight', widget)).toBeNull()
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

test('reports dedupe, viewer settings survive reports, and reset clears them', () => {
  const store = createMotionStore(() => {})
  let renders = 0
  store.subscribe(() => renders++)
  store.command({ cmd: 'seek', t: 1 })
  expect(store.get()).toBeNull()
  store.apply(report)
  store.apply(report)
  expect(renders).toBe(1)
  store.command({ cmd: 'rate', rate: 0.5 })
  store.command({ cmd: 'loop', on: true })
  store.apply({ ...report, t: 2 })
  expect(store.get()).toEqual({ duration: 4, t: 2, playing: true, rate: 0.5, loop: true })
  store.command({ cmd: 'seek', t: 10 })
  expect(store.get()?.t).toBe(4)
  store.apply({ type: 'reset' })
  expect(store.get()).toBeNull()
  store.apply(report)
  expect(store.get()?.rate).toBe(1)
  expect(store.get()?.loop).toBe(false)
})
