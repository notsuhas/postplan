import { afterEach, describe, expect, test } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'
import type { Me, PublicConfig } from '@/lib/types'
import { Component, loader, type LoginPageData } from '../login'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function renderPage(data: LoginPageData, entry = '/') {
  const router = createMemoryRouter([{ path: '/', Component, HydrateFallback: () => null, loader: () => data }], {
    initialEntries: [entry],
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
    renderPage({ googleEnabled: true, bootstrapAvailable: true, authenticated: true }, '/?error=oauth')

    const dashboard = await screen.findByRole('link', { name: 'Go to dashboard' })
    expect(dashboard.getAttribute('href')).toBe('/dashboard')
    expect(screen.queryByRole('button', { name: 'Sign in with Google' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Complete setup' })).toBeNull()
    expect(screen.queryByText(/sessions expire/)).toBeNull()
    expect(screen.queryByText(ERROR_TEXT)).toBeNull()
  })

  test('a signed-out visitor keeps every configured sign-in action', async () => {
    renderPage({ googleEnabled: true, bootstrapAvailable: true, authenticated: false })

    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Complete setup' })).toBeDefined()
    expect(screen.getByText(/sessions expire after 30 days/)).toBeDefined()
    expect(screen.queryByRole('link', { name: 'Go to dashboard' })).toBeNull()
  })

  test('the public loader reports a valid existing session without redirecting', async () => {
    const calls = stubHomepage(Response.json(USER))

    const result = await loader({ request: new Request('https://postplan.test/') } as never)

    expect(result).toEqual({ ...CONFIG, authenticated: true })
    expect(calls.sort()).toEqual(['/api/auth/me', '/api/config'])
  })

  test('a 401 identity response renders the signed-out homepage', async () => {
    stubHomepage(Response.json({ error: 'Not authenticated' }, { status: 401 }))

    const result = await loader({ request: new Request('https://postplan.test/') } as never)

    expect(result).toEqual({ ...CONFIG, authenticated: false })
  })

  test('an unavailable identity request also degrades to the signed-out homepage', async () => {
    stubHomepage(new Error('identity unavailable'))

    const result = await loader({ request: new Request('https://postplan.test/') } as never)

    expect(result).toEqual({ ...CONFIG, authenticated: false })
  })

  test('the login route still redirects an existing session to its safe destination', async () => {
    const calls = stubHomepage(Response.json(USER))

    const result = await loader({
      request: new Request('https://postplan.test/login?next=%2Fsettings%2Fkeys'),
    } as never)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(302)
    expect((result as Response).headers.get('location')).toBe('/settings/keys')
    expect(calls).toEqual(['/api/auth/me'])
  })

  test('the login route defaults an existing session to the dashboard', async () => {
    stubHomepage(Response.json(USER))

    const result = await loader({ request: new Request('https://postplan.test/login') } as never)

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).headers.get('location')).toBe('/dashboard')
  })
})

const ERROR_TEXT = "Google sign-in didn't go through. Try again."
