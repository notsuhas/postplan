// C2b — "review mode" is gone: the Done button is deleted, and Comments is a plain TOGGLE that's
// always present (not gated on `!railOpen`) with the open-count badge riding along either way.
import { describe, expect, mock, test } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { ViewerSite } from '@/lib/types'
import { ViewerTopBar } from '../ViewerTopBar'

const SITE: ViewerSite = {
  id: 's1',
  spaceSlug: 'sp',
  siteSlug: 'site',
  title: 'T',
  visibility: 'team',
  status: 'active',
  authenticated: true,
  isOwner: false,
  contentUrl: 'https://content.example.com/sp/site/',
  indexPath: 'index.html',
}

// A DATA router, not MemoryRouter: the star control (useStar) calls useRevalidator, which throws
// outside one — the top bar cannot be rendered bare any more.
function renderTopBar(
  overrides: Partial<{
    railOpen: boolean
    commentCount: number
    onToggleRail: () => void
    site: ViewerSite
    mode: 'experience' | 'comment'
    onModeChange: (mode: 'experience' | 'comment') => void
  }> = {},
) {
  const onToggleRail = overrides.onToggleRail ?? mock(() => {})
  const router = createMemoryRouter([
    {
      path: '/',
      element: (
        <ViewerTopBar
          site={overrides.site ?? SITE}
          sitePath=""
          railOpen={overrides.railOpen ?? false}
          commentCount={overrides.commentCount ?? 0}
          onToggleRail={onToggleRail}
          onToggleSidebar={() => {}}
          onSearch={() => {}}
          mode={overrides.mode}
          onModeChange={overrides.onModeChange}
        />
      ),
    },
  ])
  render(<RouterProvider router={router} />)
  return { onToggleRail }
}

test('switches explicitly between Experience and Comment modes', () => {
  const onModeChange = mock(() => {})
  renderTopBar({ mode: 'experience', onModeChange })
  expect(screen.getByRole('button', { name: 'Experience mode' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Comment mode' }))
  expect(onModeChange).toHaveBeenCalledWith('comment')
})

test('makes the selected review mode visually unmistakable in dark mode', () => {
  renderTopBar({ mode: 'comment', onModeChange: () => {} })
  const selected = screen.getByRole('button', { name: 'Comment mode' })
  const inactive = screen.getByRole('button', { name: 'Experience mode' })

  expect(selected.className).toContain('bg-primary')
  expect(selected.className).toContain('text-primary-foreground')
  expect(inactive.className).toContain('text-muted-foreground')
})

describe('ViewerTopBar — Comments is an always-present toggle (C2b: Done is gone)', () => {
  test('the Comments button renders with the rail CLOSED, and clicking it toggles', () => {
    const { onToggleRail } = renderTopBar({ railOpen: false })
    const button = screen.getByRole('button', { name: /Comments/ })
    fireEvent.click(button)
    expect(onToggleRail).toHaveBeenCalledTimes(1)
  })

  test('the Comments button ALSO renders with the rail OPEN, and clicking it toggles', () => {
    const { onToggleRail } = renderTopBar({ railOpen: true })
    const button = screen.getByRole('button', { name: /Comments/ })
    fireEvent.click(button)
    expect(onToggleRail).toHaveBeenCalledTimes(1)
  })

  test('there is no Done button in either state', () => {
    renderTopBar({ railOpen: true })
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  test('the open-count badge shows on the Comments button regardless of rail state', () => {
    renderTopBar({ railOpen: false, commentCount: 3 })
    expect(screen.getByRole('button', { name: /Comments/ }).textContent).toContain('3')
    renderTopBar({ railOpen: true, commentCount: 5 })
    expect(screen.getAllByRole('button', { name: /Comments/ }).at(-1)?.textContent).toContain('5')
  })
})

describe('ViewerTopBar — the visibility tier rides beside the site name', () => {
  test('a viewer (not the owner) sees the tier as a read-only chip', () => {
    renderTopBar({ site: { ...SITE, visibility: 'members', isOwner: false } })
    expect(screen.getByText('Space members')).toBeTruthy()
    // Read-only: the chip is text, not a picker trigger.
    expect(screen.queryByRole('button', { name: /Space members/ })).toBeNull()
  })

  test('the owner gets the picker trigger for the tier', () => {
    renderTopBar({ site: { ...SITE, visibility: 'private', isOwner: true } })
    expect(screen.getByRole('button', { name: /Restricted/ })).toBeTruthy()
  })
})

describe('ViewerTopBar — anonymous unlisted viewer', () => {
  test('offers login instead of controls that require an account', () => {
    renderTopBar({ site: { ...SITE, authenticated: false, visibility: 'unlisted' } })
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login?next=%2F')
    expect(screen.queryByRole('button', { name: /Comments/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Star this page/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull()
  })
})
