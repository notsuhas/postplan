import { expect, test } from 'bun:test'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createMotionStore } from '@/lib/motion'
import { MotionBar } from '../MotionBar'

function setup() {
  const sent: unknown[] = []
  const store = createMotionStore((m) => sent.push(m))
  const view = render(<MotionBar store={store} />)
  return { sent, store, view }
}

test('the bar stays hidden until the page reports a timeline', () => {
  const { store, view } = setup()
  expect(view.container.innerHTML).toBe('')
  act(() => store.apply({ type: 'report', duration: 65, t: 3, playing: false }))
  expect(screen.getByRole('toolbar', { name: 'Motion' })).toBeTruthy()
  expect(screen.getByText('0:03 / 1:05')).toBeTruthy()
})

test('controls and keys send commands to the page', () => {
  const { sent, store } = setup()
  act(() => store.apply({ type: 'report', duration: 4, t: 1, playing: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  fireEvent.click(screen.getByRole('button', { name: '0.5x' }))
  fireEvent.click(screen.getByRole('button', { name: 'Loop' }))
  fireEvent.keyDown(window, { key: 'ArrowRight' })
  expect(sent).toEqual([
    { type: 'postplan:motion-cmd', cmd: 'pause' },
    { type: 'postplan:motion-cmd', cmd: 'rate', rate: 0.5 },
    { type: 'postplan:motion-cmd', cmd: 'loop', on: true },
    { type: 'postplan:motion-cmd', cmd: 'step', dir: 1 },
  ])
  expect(screen.getByRole('button', { name: '0.5x' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Loop' }).getAttribute('aria-pressed')).toBe('true')
})
