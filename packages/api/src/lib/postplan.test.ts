import { describe, expect, test } from 'bun:test'
import type { SessionUser } from '../types'
import { canDiscover, checkAccess } from './access'
import { isValidSlug, slugifyHandle } from './slug'
import { signToken, verifyToken } from './token'

const owner: SessionUser = { id: 'u1', email: 'a@example.com', name: null, role: 'member', isOrgMember: true }
const other: SessionUser = { id: 'u2', email: 'b@example.com', name: null, role: 'member', isOrgMember: true }
const guest: SessionUser = { id: 'u4', email: 'd@outside.com', name: null, role: 'member', isOrgMember: false }
const admin: SessionUser = { id: 'u3', email: 'c@example.com', name: null, role: 'superadmin', isOrgMember: true }
const site = (visibility: 'unlisted' | 'private' | 'members' | 'team', status: 'active' | 'archived' = 'active') =>
  ({ visibility, status, ownerId: 'u1' }) as const

describe('checkAccess', () => {
  test('team: organization user allowed, signed-in guest denied, anon → 401', () => {
    expect(checkAccess(site('team'), other, false).ok).toBe(true)
    expect(checkAccess(site('team'), guest, false)).toEqual({ ok: false, status: 403 })
    const r = checkAccess(site('team'), null, false)
    expect(r).toEqual({ ok: false, status: 401 })
  })
  test('private: owner ok, other → 403, anon → 401', () => {
    expect(checkAccess(site('private'), owner, false).ok).toBe(true)
    expect(checkAccess(site('private'), other, false)).toEqual({ ok: false, status: 403 })
    expect(checkAccess(site('private'), null, false)).toEqual({ ok: false, status: 401 })
  })
  test('members: member ok, non-member → 403', () => {
    expect(checkAccess(site('members'), other, true).ok).toBe(true)
    expect(checkAccess(site('members'), other, false)).toEqual({ ok: false, status: 403 })
  })
  test('archived: 410 for everyone, superadmin included', () => {
    expect(checkAccess(site('team', 'archived'), owner, false)).toEqual({ ok: false, status: 410 })
    expect(checkAccess(site('private', 'archived'), admin, false)).toEqual({ ok: false, status: 410 })
  })
  // The read side of "a superadmin may delete a private site but never open it": role buys nothing
  // here, so an admin is judged by the same tiers as any other non-owner.
  test('superadmin gets NO bypass — judged by tier like any member', () => {
    expect(checkAccess(site('private'), admin, false)).toEqual({ ok: false, status: 403 })
    expect(checkAccess(site('members'), admin, false)).toEqual({ ok: false, status: 403 })
    expect(checkAccess(site('team'), admin, false).ok).toBe(true)
    expect(checkAccess(site('members'), admin, true).ok).toBe(true)
    expect(checkAccess(site('private'), admin, false, true).ok).toBe(true)
  })
  test('explicit share grants access on any tier', () => {
    expect(checkAccess(site('private'), other, false, true).ok).toBe(true)
    expect(checkAccess(site('members'), other, false, true).ok).toBe(true)
  })
  test('explicit share is still blocked when archived', () => {
    expect(checkAccess(site('private', 'archived'), other, false, true)).toEqual({ ok: false, status: 410 })
  })
})

describe('canDiscover', () => {
  test('an unlisted site is discoverable only to its owner or an explicit share', () => {
    expect(canDiscover(site('unlisted'), owner, true)).toBe(true)
    expect(canDiscover(site('unlisted'), other, true)).toBe(false)
    expect(canDiscover(site('unlisted'), other, false, true)).toBe(true)
  })
})

describe('isValidSlug', () => {
  test('accepts lowercase alphanumeric + hyphen, 3–40 chars', () => {
    expect(isValidSlug('abc')).toBe(true)
    expect(isValidSlug('my-runbook')).toBe(true)
    expect(isValidSlug('a1-b2-c3')).toBe(true)
  })
  test('rejects bad slugs', () => {
    expect(isValidSlug('ab')).toBe(false) // too short
    expect(isValidSlug('Abc')).toBe(false) // uppercase
    expect(isValidSlug('-lead')).toBe(false) // leading hyphen
    expect(isValidSlug('trail-')).toBe(false) // trailing hyphen
    expect(isValidSlug('a'.repeat(41))).toBe(false) // too long
    expect(isValidSlug('has space')).toBe(false)
  })
  test('rejects reserved slugs', () => {
    expect(isValidSlug('admin')).toBe(false)
    expect(isValidSlug('api')).toBe(false)
    expect(isValidSlug('content')).toBe(false)
    expect(isValidSlug('docs')).toBe(false)
  })
})

describe('slugifyHandle', () => {
  test('sanitizes email handles', () => {
    expect(slugifyHandle('jane.doe@example.com')).toBe('jane-doe')
    expect(slugifyHandle('jo@example.com')).toBe('jo-postplan') // padded to >= 3
  })
})

describe('signToken / verifyToken', () => {
  const secret = 'test-secret'
  const uid = 'u1'
  test('valid round-trip returns the bound userId', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken(secret, 'sam/site', t)).toBe(uid)
  })
  test('wrong scope → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken(secret, 'sam/other', t)).toBeNull()
  })
  test('tampered mac → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken(secret, 'sam/site', `${t.slice(0, -2)}xx`)).toBeNull()
  })
  test('expired → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', -1)
    expect(await verifyToken(secret, 'sam/site', t)).toBeNull()
  })
  test('wrong secret → null', async () => {
    const t = await signToken(secret, uid, 'sam/site', 300)
    expect(await verifyToken('other-secret', 'sam/site', t)).toBeNull()
  })
  test('missing token → null', async () => {
    expect(await verifyToken(secret, 'sam/site', null)).toBeNull()
  })
})
