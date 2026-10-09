import { expect, test } from 'bun:test'
import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { VideoView } from '../VideoView'

const SRC = 'https://content.test/_t/token/sp/site/explainer.mp4'

test('video renders a native player with original and download links', () => {
  const videoRef = createRef<HTMLVideoElement>()
  const { container } = render(<VideoView src={SRC} fileName="explainer.mp4" videoRef={videoRef} />)
  const video = container.querySelector('video')
  expect(video?.getAttribute('src')).toBe(SRC)
  expect(video?.hasAttribute('controls')).toBe(true)
  expect(video?.hasAttribute('playsinline')).toBe(true)
  expect(video?.getAttribute('preload')).toBe('metadata')
  expect(videoRef.current).toBe(video)
  expect(screen.getByRole('link', { name: 'Open original' }).getAttribute('href')).toBe(SRC)
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(`${SRC}?download=1`)
})

test('unplayable video shows a useful error', () => {
  const { container } = render(<VideoView src={SRC} fileName="explainer.mp4" videoRef={createRef()} />)
  fireEvent.error(container.querySelector('video') as HTMLVideoElement)
  expect(screen.getByRole('alert').textContent).toContain('Could not play')
  expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy()
})
