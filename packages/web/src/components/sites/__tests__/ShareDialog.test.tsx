import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { api } from '@/lib/api'
import { ShareDialog } from '../ShareDialog'

const spies: { mockRestore(): void }[] = []

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

function renderOpen() {
  const router = createMemoryRouter([
    {
      path: '/',
      element: <ShareDialog spaceSlug="studio" siteSlug="demo" open onOpenChange={() => {}} />,
    },
  ])
  render(<RouterProvider router={router} />)
}

describe('ShareDialog loading failure', () => {
  test('cannot replace shares with an empty set when the current share set failed to load', async () => {
    const get = spyOn(api, 'get').mockRejectedValue(new Error('offline'))
    const put = spyOn(api, 'put').mockResolvedValue({})
    spies.push(get, put)
    renderOpen()

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load sharing')
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    expect(put).not.toHaveBeenCalled()
  })
})
