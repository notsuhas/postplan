import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { api } from '@/lib/api'
import type { SpaceSummary } from '@/lib/types'
import { UploadDialog } from './UploadDialog'

const SPACE: SpaceSummary = {
  id: 'space-1',
  slug: 'studio',
  name: 'Studio',
  type: 'group',
}

class FakeXMLHttpRequest {
  static instances: FakeXMLHttpRequest[] = []

  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ''
  withCredentials = false
  url = ''
  aborted = false

  open(_method: string, url: string) {
    this.url = url
  }

  setRequestHeader() {}

  getResponseHeader() {
    return null
  }

  send() {
    FakeXMLHttpRequest.instances.push(this)
  }

  abort() {
    this.aborted = true
    this.onabort?.()
  }

  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
  }
}

const originalXHR = globalThis.XMLHttpRequest
const spies: { mockRestore(): void }[] = []

beforeEach(() => {
  FakeXMLHttpRequest.instances = []
  globalThis.XMLHttpRequest = FakeXMLHttpRequest as unknown as typeof XMLHttpRequest
})

afterEach(() => {
  globalThis.XMLHttpRequest = originalXHR
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function renderDialog(onOpenChange = mock((_open: boolean) => {})) {
  const router = createMemoryRouter([
    {
      path: '/',
      element: <UploadDialog spaces={[SPACE]} open onOpenChange={onOpenChange} />,
    },
  ])
  const view = render(<RouterProvider router={router} />)
  return { ...view, onOpenChange }
}

function chooseFile(name = 'index.html') {
  const inputs = document.body.querySelectorAll<HTMLInputElement>('input[type="file"]')
  const input = inputs[1]
  if (!input) throw new Error('file picker not rendered')
  fireEvent.change(input, { target: { files: [new File(['<h1>hello</h1>'], name, { type: 'text/html' })] } })
}

function setSlug(value = 'demo') {
  fireEvent.change(screen.getByLabelText('Slug'), { target: { value } })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('UploadDialog reliability', () => {
  test('locks the destination and removes every dismissal control while an upload is running', async () => {
    const get = spyOn(api, 'get').mockResolvedValue({ exists: false })
    spies.push(get)
    const { onOpenChange } = renderDialog()

    setSlug()
    chooseFile()
    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(1))

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect((screen.getByLabelText('Slug') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('combobox', { name: 'Space' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /All users/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  test('locks the modal during the final ownership check before the upload starts', async () => {
    const availability = deferred<{ exists: false }>()
    const get = spyOn(api, 'get').mockImplementation(() => availability.promise)
    spies.push(get)
    const { unmount } = renderDialog()

    setSlug()
    chooseFile()
    const status = await screen.findByRole('status')
    expect(status.textContent).toContain('Checking destination…')

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect((screen.getByLabelText('Slug') as HTMLInputElement).disabled).toBe(true)
    expect(FakeXMLHttpRequest.instances.length).toBe(0)

    await act(async () => availability.resolve({ exists: false }))
    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(1))
    unmount()
  })

  test('renders a failed upload and retries the same files without another file-picker action', async () => {
    const get = spyOn(api, 'get').mockResolvedValue({ exists: false })
    spies.push(get)
    renderDialog()

    setSlug()
    chooseFile()
    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(1))
    act(() => FakeXMLHttpRequest.instances[0]?.respond(503, { error: 'storage unavailable' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('storage unavailable')
    fireEvent.click(screen.getByRole('button', { name: 'Retry file' }))

    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(2))
    expect(get).toHaveBeenCalledTimes(2)
    expect(FakeXMLHttpRequest.instances[1]?.url).toBe('/api/upload/studio/demo')
  })

  test('rechecks ownership at submit instead of trusting an earlier available result', async () => {
    const answers = [{ exists: false } as const, { exists: true, owned: true } as const]
    const get = spyOn(api, 'get').mockImplementation(async () => answers.shift() ?? { exists: true, owned: true })
    spies.push(get)
    renderDialog()

    setSlug()
    fireEvent.blur(screen.getByLabelText('Slug'))
    await screen.findByText('available')

    chooseFile()
    expect(await screen.findByRole('heading', { name: /Replace studio\/demo/ })).toBeTruthy()
    expect(get).toHaveBeenCalledTimes(2)
    expect(FakeXMLHttpRequest.instances.length).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(1))
    expect(FakeXMLHttpRequest.instances[0]?.url).toBe('/api/upload/studio/demo?replace=true')
  })

  test('discards an ownership response after the user changes the destination', async () => {
    const firstCheck = deferred<{ exists: true; owned: true }>()
    const get = spyOn(api, 'get')
      .mockImplementationOnce(() => firstCheck.promise)
      .mockResolvedValueOnce({ exists: false })
    spies.push(get)
    const { unmount } = renderDialog()

    setSlug('old-slug')
    fireEvent.blur(screen.getByLabelText('Slug'))
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1))

    setSlug('new-slug')
    await act(async () => firstCheck.resolve({ exists: true, owned: true }))
    expect(screen.queryByText(/you already own this/)).toBeNull()

    chooseFile()
    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(1))
    expect(FakeXMLHttpRequest.instances[0]?.url).toBe('/api/upload/studio/new-slug')
    unmount()
  })

  test('aborts the request if navigation unmounts the uploader', async () => {
    const get = spyOn(api, 'get').mockResolvedValue({ exists: false })
    spies.push(get)
    const { unmount } = renderDialog()

    setSlug()
    chooseFile()
    await waitFor(() => expect(FakeXMLHttpRequest.instances.length).toBe(1))
    unmount()

    expect(FakeXMLHttpRequest.instances[0]?.aborted).toBe(true)
  })
})
