import type { Bindings } from '../types'

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

function orgEmailDomains(env: Pick<Bindings, 'ORG_EMAIL_DOMAINS'>): string[] {
  return (env.ORG_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean)
}

export function isOrgEmail(env: Pick<Bindings, 'ORG_EMAIL_DOMAINS'>, email: string): boolean {
  const domain = email.toLowerCase().split('@')[1]
  return Boolean(domain && orgEmailDomains(env).includes(domain))
}
