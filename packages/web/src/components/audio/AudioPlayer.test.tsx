import { describe, expect, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { AudioPlayer } from './AudioPlayer'

describe('AudioPlayer', () => {
  test('shows media loading failures and disables playback controls', () => {
    const { container } = render(<AudioPlayer src="/missing.mp3" />)
    fireEvent.error(container.querySelector('audio') as HTMLAudioElement)

    expect(screen.getByRole('alert').textContent).toContain('could not be loaded')
    expect((screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('slider', { name: 'Seek' }) as HTMLInputElement).disabled).toBe(true)
  })
})
