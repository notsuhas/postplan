import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { api } from '@/lib/api'
import type { SpaceDetail } from '@/lib/types'
import { Component } from './space'

const spies: { mockRestore(): void }[] = []

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

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
  const router = createMemoryRouter([
    { path: '/', Component, HydrateFallback: () => null, loader: () => ({ space, sites: [] }) },
  ])
  return render(<RouterProvider router={router} />)
}

describe('space membership controls', () => {
  test('an owner sees the roster, owner badge, invite and member removal', async () => {
    renderSpace(SPACE)
    expect(await screen.findByText('member@example.com')).toBeTruthy()
    expect(screen.getAllByText('Owner')).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Invite members' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Transfer' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Delete space' })).toBeTruthy()
  })

  test('ownership transfer requires confirmation and sends the selected member id', async () => {
    const patch = spyOn(api, 'patch').mockResolvedValue({})
    spies.push(patch)
    renderSpace(SPACE)

    fireEvent.click(await screen.findByRole('button', { name: 'Transfer' }))
    expect(await screen.findByText(/You will remain a member/)).toBeTruthy()
    expect(patch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Transfer ownership' }))
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/api/spaces/studio/owner', { userId: 'member' }))
  })

  test('a non-owner gets no owner-only controls that would only fail', async () => {
    renderSpace({ ...SPACE, isOwner: false, members: undefined })
    expect(await screen.findByText('Studio')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Invite members' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Transfer' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete space' })).toBeNull()
  })
})
