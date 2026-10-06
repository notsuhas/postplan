import type { Context } from 'hono'
import type { AppEnv, Bindings, SessionUser } from '../types'
import { isWorkosEnabled, workosProvider } from './workos'

/** Claims obtained by the adapter through server-side verification, never from the browser.
 * `sub` is the provider's stable identity id; email must be verified before account linking. */
export interface IdpClaims {
  sub: string
  email: string
  email_verified: boolean
  name?: string
  picture?: string
}

export interface BrowserSignIn {
  label: string
  icon?: 'google'
}

export interface BrowserAuthProvider {
  /** Stable namespace. Only WorkOS keeps its historic, unprefixed database subjects. */
  id: string
  signIn: BrowserSignIn
  /** The provider owns its handshake (OAuth state, or a hosted cookie-based login). */
  start(c: Context<AppEnv>, next: string | null): Promise<Response>
  /** A Response means the handshake failed; successful claims go through shared access gates. */
  complete(c: Context<AppEnv>): Promise<{ claims: IdpClaims; next: string | null } | Response>
  /** Optional live provider check for app browser sessions. Bind the verified provider identity
   * to this local user; false or an error denies access. CLI tokens/API keys remain app-owned. */
  validateSession?(c: Context<AppEnv>, user: SessionUser): Promise<boolean>
  /** Optional provider-local cleanup. Shared identities must never be deleted on app denial. */
  onDenied?(c: Context<AppEnv>, claims: IdpClaims): Promise<void>
  /** Optional hosted sign-out. Return a trusted provider logout URL for browser navigation.
   * Throw on failure; never report global sign-out as complete while the SSO session is live. */
  logout?(c: Context<AppEnv>): Promise<string | null>
  recordLogin?(c: Context<AppEnv>, claims: IdpClaims): Promise<void>
}

/** The single selection point used by both browser routes and public login configuration.
 * An Ory adapter can be selected here without changing user/session/CLI handling or the SPA. */
export function resolveBrowserAuthProvider(env: Bindings): BrowserAuthProvider | null {
  return isWorkosEnabled(env) ? workosProvider : null
}

export function identitySubject(providerId: string, sub: string): string {
  return providerId === 'workos' ? sub : `${providerId}:${sub}`
}
