import { describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { SpaceDetail } from '@/lib/types'
import { Component } from './space'

const SPACE: SpaceDetail = {
  id: 'space-1',
  slug: 'studio',
  name: 'Studio',
  type: 'group',
  memberCount: 2,
  isMember: true,
  isOwner: true,
  ownerId: 'owner',
  members: [
    { id: 'member', name: 'Member', email: 'member@example.com' },
    { id: 'owner', name: 'Owner', email: 'owner@example.com' },
  ],
}

function renderSpace(space: SpaceDetail) {
  const router = createMemoryRouter([{ path: '/', Component, loader: () => ({ space, sites: [] }) }])
  return render(<RouterProvider router={router} />)
}

describe('space membership controls', () => {
  test('an owner sees the roster, owner badge, invite and member removal', async () => {
    renderSpace(SPACE)
    expect(await screen.findByText('member@example.com')).toBeTruthy()
    expect(screen.getAllByText('Owner')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Invite members' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete space' })).toBeTruthy()
  })

  test('a non-owner gets no owner-only controls that would only fail', async () => {
    renderSpace({ ...SPACE, isOwner: false, members: undefined })
    expect(await screen.findByText('Studio')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete space' })).toBeNull()
  })
})
