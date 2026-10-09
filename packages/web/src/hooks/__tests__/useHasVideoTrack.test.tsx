import { afterEach, beforeEach, expect, type Mock, spyOn, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useHasVideoTrack } from '../useHasVideoTrack'

const probes: HTMLVideoElement[] = []
let create: Mock<typeof document.createElement>

beforeEach(() => {
  const realCreate = document.createElement.bind(document)
  create = spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreate(tag)
    if (tag === 'video') probes.push(el as HTMLVideoElement)
    return el
  }) as typeof document.createElement)
})

afterEach(() => {
  create.mockRestore()
  probes.length = 0
})

function loadMetadata(probe: HTMLVideoElement, videoWidth: number) {
  Object.defineProperty(probe, 'videoWidth', { value: videoWidth, configurable: true })
  act(() => probe.onloadedmetadata?.(new Event('loadedmetadata')))
}

test('reports a picture only once metadata shows a video track', () => {
  const { result } = renderHook(() => useHasVideoTrack('https://content.test/take.webm'))
  expect(result.current).toBe(false)
  loadMetadata(probes[0] as HTMLVideoElement, 1280)
  expect(result.current).toBe(true)
})

test('audio-only webm stays audio', () => {
  const { result } = renderHook(() => useHasVideoTrack('https://content.test/voice.webm'))
  loadMetadata(probes[0] as HTMLVideoElement, 0)
  expect(result.current).toBe(false)
})

test('no source means no probe', () => {
  const { result } = renderHook(() => useHasVideoTrack(null))
  expect(result.current).toBe(false)
  expect(probes.length).toBe(0)
})
