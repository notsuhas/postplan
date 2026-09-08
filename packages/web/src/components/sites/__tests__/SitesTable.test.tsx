import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { api } from '@/lib/api'
import type { SiteSummary, SpaceSummary } from '@/lib/types'
import { SitesTable } from '../SitesTable'

const SITE: SiteSummary = {
  id: 'site-1',
  spaceSlug: 'source',
  siteSlug: 'demo',
  title: 'Demo',
  visibility: 'members',
  status: 'active',
  url: 'https://postplan.example.com/source/demo',
  createdAt: '2026-09-05T00:00:00.000Z',
  updatedAt: '2026-09-05T00:00:00.000Z',
}

const DESTINATION: SpaceSummary = {
  id: 'space-2',
  slug: 'destination',
  name: 'Destination',
  type: 'group',
}

const spies: { mockRestore(): void }[] = []

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function renderTable() {
  const router = createMemoryRouter([{ path: '/', element: <SitesTable sites={[SITE]} /> }])
  render(<RouterProvider router={router} />)
}

describe('MoveDialog audience changes', () => {
  test('a members site requires explicit acknowledgement and sends it to the API', async () => {
    const get = spyOn(api, 'get').mockResolvedValue([DESTINATION])
    const post = spyOn(api, 'post').mockResolvedValue({ url: 'https://postplan.example.com/destination/demo' })
    spies.push(get, post)
    renderTable()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move' }))

    expect(await screen.findByText('This changes who can view the site')).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('combobox'), { button: 0, pointerType: 'mouse' })
    fireEvent.click(await screen.findByRole('option', { name: /destination/ }))

    const move = screen.getByRole('button', { name: 'Move and change audience' }) as HTMLButtonElement
    expect(move.disabled).toBe(true)
    expect(post).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox'))
    expect(move.disabled).toBe(false)
    fireEvent.click(move)

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/sites/source/demo/move', {
        space: 'destination',
        confirmAudienceChange: true,
      }),
    )
  })
})

describe('VersionHistoryDialog', () => {
  test('shows a file diff and rolls back from the current version', async () => {
    const get = spyOn(api, 'get').mockResolvedValue([
      {
        version: 2,
        createdAt: '2026-09-05T00:00:00.000Z',
        createdBy: 'owner',
        restoredFrom: null,
        current: true,
        files: [{ path: 'index.html', size: 20, etag: 'new' }],
      },
      {
        version: 1,
        createdAt: '2026-09-04T00:00:00.000Z',
        createdBy: 'owner',
        restoredFrom: null,
        current: false,
        files: [{ path: 'index.html', size: 10, etag: 'old' }],
      },
    ])
    const post = spyOn(api, 'post').mockResolvedValue({ version: 3, restoredFrom: 1 })
    spies.push(get, post)
    renderTable()

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions' }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Version history' }))
    expect(await screen.findByText(/0 added · 1 changed · 0 removed/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    const confirmation = await screen.findByRole('alertdialog')
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Restore' }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/sites/source/demo/versions/1/rollback', { expectedVersion: 2 }),
    )
  })
})
