import type { ShareUser } from '../db/repo'

export function parseShareGrants(body: unknown): { users: ShareUser[]; groupIds: string[] } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'invalid request' }
  const value = body as Record<string, unknown>
  if (!Array.isArray(value.users) || (value.groupIds !== undefined && !Array.isArray(value.groupIds))) {
    return { error: 'invalid request' }
  }

  const roles = new Map<string, 'viewer' | 'editor'>()
  for (const user of value.users as { id?: unknown; role?: unknown }[]) {
    if (typeof user?.id !== 'string' || (user.role !== 'viewer' && user.role !== 'editor')) {
      return { error: 'invalid user grant' }
    }
    roles.set(user.id, user.role)
  }

  const rawGroups = (value.groupIds ?? []) as unknown[]
  if (rawGroups.some((id) => typeof id !== 'string')) return { error: 'invalid group grant' }
  return {
    users: [...roles].map(([userId, role]) => ({ userId, role })),
    groupIds: [...new Set(rawGroups as string[])],
  }
}
