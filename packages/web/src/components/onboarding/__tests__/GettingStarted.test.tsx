// S12: the walkthrough (rendered in both the dashboard empty state and the HelpButton sheet)
// links to the API keys docs page — one link, both surfaces, for free.
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { GettingStarted } from '../GettingStarted'

function renderIt() {
  const router = createMemoryRouter([{ path: '/', Component: GettingStarted }], { initialEntries: ['/'] })
  return render(<RouterProvider router={router} />)
}

describe('GettingStarted', () => {
  test('links to /docs/api-keys', async () => {
    renderIt()
    const link = (await screen.findByText(/API keys/)).closest('a')
    expect(link?.getAttribute('href')).toBe('/docs/api-keys')
  })

  test('notifies its container before navigating', async () => {
    const onNavigate = mock(() => {})
    const router = createMemoryRouter([{ path: '/', element: <GettingStarted onNavigate={onNavigate} /> }])
    render(<RouterProvider router={router} />)

    fireEvent.click(await screen.findByText(/API keys/))
    expect(onNavigate).toHaveBeenCalledTimes(1)
  })
})
