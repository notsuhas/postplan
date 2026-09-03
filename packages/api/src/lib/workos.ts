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

/** The superadmin allowlist. Two effects: these addresses bypass the invite gate (so a fresh
 *  instance is reachable before any invite row exists), and findOrCreateUser grants them the
 *  `superadmin` role on every login. SUPERADMIN_EMAIL is always one — it is the address the
 *  first-run bootstrap token claims — and SUPERADMIN_EMAILS adds the rest.
 *
 *  There is no lesser "admin" role: users.role is `member | superadmin`, so a name like
 *  ADMIN_EMAILS promised a tier that does not exist. That spelling is still read as a fallback. */
export function isAdminEmail(env: Bindings, email: string): boolean {
  // Both are optional in tests and on a half-configured deploy; interpolating an undefined here
  // would put the literal string "undefined" in the allowlist.
  const extra = env.SUPERADMIN_EMAILS ?? env.ADMIN_EMAILS ?? ''
  const list = `${env.SUPERADMIN_EMAIL ?? ''},${extra}`.toLowerCase()
  return list
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .includes(email.toLowerCase())
}
