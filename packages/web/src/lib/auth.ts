import { toast } from 'sonner'
import { api } from './api'

/** A hosted provider may need a browser round-trip to finish logout. */
export async function signOut(): Promise<void> {
  try {
    const result = await api.post<{ ok: boolean; redirectTo?: string }>('/api/auth/logout')
    window.location.href = result.redirectTo ?? '/login'
  } catch {
    toast.error('Could not sign out. Please try again.')
  }
}
