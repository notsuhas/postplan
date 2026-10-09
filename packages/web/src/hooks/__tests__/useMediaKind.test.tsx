import { afterEach, beforeEach, expect, type Mock, spyOn, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useMediaKind } from '../useMediaKind'

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

test('static kinds come straight from the extension, without probing', () => {
  expect(renderHook(() => useMediaKind('clip.mp4', 'https://c.test/clip.mp4')).result.current).toBe('video')
  expect(renderHook(() => useMediaKind(null, 'https://c.test/')).result.current).toBe('document')
  expect(probes.length).toBe(0)
})

test('webm is probing until metadata decides between video and audio', () => {
  const { result } = renderHook(() => useMediaKind('take.webm', 'https://c.test/take.webm'))
  expect(result.current).toBe('probing')
  Object.defineProperty(probes[0], 'videoWidth', { value: 0, configurable: true })
  act(() => probes[0]?.onloadedmetadata?.(new Event('loadedmetadata')))
  expect(result.current).toBe('audio')
})
