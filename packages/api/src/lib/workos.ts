import { WorkOS } from '@workos-inc/node/worker'
import type { Bindings } from '../types'

/** WorkOS is usable only when both credentials are configured. When false the deploy runs
 *  bootstrap-only and the WorkOS routes are inert — the same contract the Google routes had.
 *  WorkOS brokers the Google handshake with its own OAuth credentials, so there is no Google
 *  Cloud project to own here. */
export function isWorkosEnabled(env: Bindings): boolean {
  return Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID)
}

/** Single source of truth for the WorkOS client. Call only when `isWorkosEnabled` — the guards
 *  above must keep undefined creds from reaching `new WorkOS`. The `/worker` entrypoint is the
 *  fetch-based build; the default one pulls node:https and will not run on workerd. */
export function createWorkos(env: Bindings): WorkOS {
  if (!isWorkosEnabled(env)) throw new Error('WorkOS is not configured')
  return new WorkOS(env.WORKOS_API_KEY as string, { clientId: env.WORKOS_CLIENT_ID as string })
}

/** Configured superadmins; the first address owns bootstrap and local dev login. */
export function superadminEmails(env: Pick<Bindings, 'SUPERADMIN_EMAILS'>): string[] {
  return (env.SUPERADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => e.toLowerCase())
}

export function primarySuperadminEmail(env: Pick<Bindings, 'SUPERADMIN_EMAILS'>): string {
  const email = superadminEmails(env)[0]
  if (!email) throw new Error('SUPERADMIN_EMAILS must contain at least one email')
  return email
}

export function isAdminEmail(env: Pick<Bindings, 'SUPERADMIN_EMAILS'>, email: string): boolean {
  return superadminEmails(env).includes(email.toLowerCase())
}
