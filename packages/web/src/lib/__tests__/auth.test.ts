import { afterEach, expect, spyOn, test } from 'bun:test'
import { toast } from 'sonner'
import { signOut } from '../auth'

const originalFetch = globalThis.fetch
const previousHref = Object.getOwnPropertyDescriptor(window.location, 'href')
afterEach(() => {
  globalThis.fetch = originalFetch
  if (previousHref) Object.defineProperty(window.location, 'href', previousHref)
  else Reflect.deleteProperty(window.location, 'href')
})

function setup(response: Response) {
  Object.defineProperty(window.location, 'href', { value: '/dashboard', writable: true, configurable: true })
  globalThis.fetch = (async () => response) as typeof fetch
}

test('hosted logout navigates to the provider URL so its browser session can end', async () => {
  setup(Response.json({ ok: true, redirectTo: 'https://auth.example.com/logout?token=one-use' }))
  await signOut()
  expect(window.location.href).toBe('https://auth.example.com/logout?token=one-use')
})

test('local logout retains the login destination', async () => {
  setup(Response.json({ ok: true }))
  await signOut()
  expect(window.location.href).toBe('/login')
})

test('logout failure shows an error and does not claim sign-out by navigating away', async () => {
  setup(Response.json({ error: 'provider unavailable' }, { status: 500 }))
  const error = spyOn(toast, 'error').mockImplementation(() => 'test-toast')
  try {
    await signOut()
    expect(window.location.href).toBe('/dashboard')
    expect(error).toHaveBeenCalledWith('Could not sign out. Please try again.')
  } finally {
    error.mockRestore()
  }
})
