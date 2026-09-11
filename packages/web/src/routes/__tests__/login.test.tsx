import { afterEach, describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Me, PublicConfig } from '@/lib/types'
import { Component, loader, type LoginPageData } from '../login'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function renderPage(data: LoginPageData) {
  const router = createMemoryRouter([{ path: '/', Component, HydrateFallback: () => null, loader: () => data }], {
    initialEntries: ['/'],
  })
  return render(<RouterProvider router={router} />)
}

const CONFIG: PublicConfig = { googleEnabled: true, bootstrapAvailable: false }

const USER: Me = {
  id: 'user-1',
  email: 'reviewer@example.com',
  name: 'Reviewer',
  role: 'member',
  isOrgMember: true,
  hasUsedCli: true,
}

function stubHomepage(identity: Response | Error) {
  const calls: string[] = []
  globalThis.fetch = ((url: string) => {
    calls.push(url)
    if (url === '/api/config') return Promise.resolve(Response.json(CONFIG))
    if (url === '/api/auth/me') {
      return identity instanceof Error ? Promise.reject(identity) : Promise.resolve(identity)
    }
    return Promise.reject(new Error(`unexpected request: ${url}`))
  }) as unknown as typeof fetch
  return calls
}

describe('homepage authentication action', () => {
  test('an authenticated visitor gets one direct dashboard action', async () => {
    renderPage({ ...CONFIG, authenticated: true })

    const dashboard = await screen.findByRole('link', { name: 'Go to dashboard' })
    expect(dashboard.getAttribute('href')).toBe('/dashboard')
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull()
  })

  test('a signed-out visitor keeps the configured Google sign-in action', async () => {
    renderPage({ ...CONFIG, authenticated: false })

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Go to dashboard' })).toBeNull()
  })

  test('the public loader reports a valid existing session without redirecting', async () => {
    const calls = stubHomepage(Response.json(USER))

    const result = await loader({ request: new Request('https://postplan.test/') } as never)

    expect(result).toEqual({ ...CONFIG, authenticated: true })
    expect(calls.sort()).toEqual(['/api/auth/me', '/api/config'])
  })

  test('an unavailable identity request degrades to the signed-out homepage', async () => {
    stubHomepage(new Error('identity unavailable'))

    const result = await loader({ request: new Request('https://postplan.test/') } as never)

    expect(result).toEqual({ ...CONFIG, authenticated: false })
  })
})
