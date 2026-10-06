import { describe, expect, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import type { Thread } from '@/lib/comments'
import { useViewerComments } from '../useViewerComments'

const site = { spaceSlug: 'docs', siteSlug: 'demo' }
const thread = (id: string) => ({ id, status: 'open' }) as Thread

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('viewer comment synchronization', () => {
  test('holds HTML prefetch until the frame confirms its file', async () => {
    const { result } = renderHook(() => useViewerComments(site, 'index.html', false, false))
    await act(async () => {
      await result.current.loadThreads('index.html', {
        provisional: true,
        prefetch: Promise.resolve([thread('first')]),
      })
    })
    expect(result.current.threads).toEqual([])
    act(() => {
      result.current.dispatch({ type: 'ready', path: 'index.html' })
    })
    expect(result.current.threads.map((item) => item.id)).toEqual(['first'])
    expect(result.current.resolvedFilePath).toBe('index.html')
  })

  test('a late prefetch cannot replace comments loaded after navigation', async () => {
    const old = deferred<Thread[]>()
    const { result } = renderHook(() => useViewerComments(site, 'old.html', false, false))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.loadThreads('old.html', { prefetch: old.promise })
    })
    await act(async () => {
      result.current.dispatch({ type: 'navReset', expected: 'new.html' })
      await result.current.loadThreads('new.html', { prefetch: Promise.resolve([thread('new')]) })
    })
    await act(async () => {
      old.resolve([thread('old')])
      await pending
    })
    expect(result.current.threads.map((item) => item.id)).toEqual(['new'])
  })

  test('media prefetch applies without waiting for an iframe and folds queued updates', async () => {
    const read = deferred<Thread[]>()
    const { result } = renderHook(() => useViewerComments(site, 'recording.webm', true, false))
    let pending!: Promise<void>
    act(() => {
      pending = result.current.loadThreads('recording.webm', { prefetch: read.promise })
      result.current.dispatch({ type: 'push', apply: (items) => [...items, thread('pushed')] })
    })
    await act(async () => {
      read.resolve([thread('listed')])
      await pending
    })
    expect(result.current.threads.map((item) => item.id)).toEqual(['listed', 'pushed'])
  })
})
