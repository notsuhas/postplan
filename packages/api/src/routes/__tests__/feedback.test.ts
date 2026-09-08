import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { feedbackBatches } from '../../db/schema'
import { authHeaders, makeRouteApp, mintUser } from '../../test/route-fixtures'
import { seedComment, seedMember, seedSite, seedSpace, seedThread } from '../../test/harness'

async function setup() {
  const s = makeRouteApp()
  const reviewer = await mintUser(s.db, s.kv, 'reviewer')
  const spaceId = await seedSpace(s.db, { createdBy: reviewer, slug: 'docs' })
  await seedMember(s.db, spaceId, reviewer)
  const siteId = await seedSite(s.db, { spaceId, ownerId: reviewer, slug: 'guide', contentVersion: 4 })
  const threadId = await seedThread(s.db, {
    id: 'thread-1',
    siteId,
    filePath: 'index.html',
    quote: 'Old heading',
    anchor: { version: 1, prefix: 'Before ', suffix: ' after' },
    createdBy: reviewer,
  })
  const selected = await seedComment(s.db, {
    id: 'comment-1',
    threadId,
    authorId: reviewer,
    body: 'Please tighten this heading.',
  })
  const unsent = await seedComment(s.db, {
    id: 'comment-2',
    threadId,
    authorId: reviewer,
    body: 'This stays human-only.',
  })
  return { ...s, reviewer, selected, unsent }
}

describe('feedback batches', () => {
  test('send snapshots only explicitly selected comments at the reviewed version', async () => {
    const s = await setup()
    const res = await s.app.request(
      '/api/sites/docs/guide/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(s.reviewer), 'Idempotency-Key': 'send-1' },
        body: JSON.stringify({ commentIds: [s.selected] }),
      },
      s.env,
    )
    expect(res.status).toBe(201)
    const batch = (await res.json()) as { id: string; status: string; siteVersion: number; items: unknown[] }
    expect(batch.status).toBe('queued')
    expect(batch.siteVersion).toBe(4)
    expect(batch.items).toHaveLength(1)
    expect(batch.items[0]).toMatchObject({
      commentId: s.selected,
      threadId: 'thread-1',
      page: 'index.html',
      author: { id: s.reviewer },
      text: 'Please tighten this heading.',
      version: 4,
    })
  })

  test('undo cancels within five seconds and replay is idempotent', async () => {
    const s = await setup()
    const create = () =>
      s.app.request(
        '/api/sites/docs/guide/feedback',
        {
          method: 'POST',
          headers: { ...authHeaders(s.reviewer), 'Idempotency-Key': 'same-send' },
          body: JSON.stringify({ commentIds: [s.selected] }),
        },
        s.env,
      )
    const first = await create()
    const second = await create()
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const a = (await first.json()) as { id: string }
    const b = (await second.json()) as { id: string }
    expect(b.id).toBe(a.id)

    const undo = await s.app.request(
      `/api/sites/docs/guide/feedback/${a.id}/undo`,
      { method: 'POST', headers: { ...authHeaders(s.reviewer), 'Idempotency-Key': 'undo-1' } },
      s.env,
    )
    expect(undo.status).toBe(200)
    expect(await undo.json()).toMatchObject({ id: a.id, status: 'cancelled' })
  })

  test('one agent atomically claims a claimable batch', async () => {
    const s = await setup()
    const send = await s.app.request(
      '/api/sites/docs/guide/feedback',
      {
        method: 'POST',
        headers: { ...authHeaders(s.reviewer), 'Idempotency-Key': 'send-claim' },
        body: JSON.stringify({ commentIds: [s.selected] }),
      },
      s.env,
    )
    const batch = (await send.json()) as { id: string }
    await s.db
      .update(feedbackBatches)
      .set({ claimableAt: new Date(0).toISOString() })
      .where(eq(feedbackBatches.id, batch.id))

    const claim = (key: string) =>
      s.app.request(
        `/api/feedback/${batch.id}/claim`,
        { method: 'POST', headers: { ...authHeaders(s.reviewer), 'Idempotency-Key': key } },
        s.env,
      )
    const first = await claim('claim-1')
    const second = await claim('claim-2')
    expect(first.status).toBe(200)
    expect((await first.json()) as { status: string }).toMatchObject({ status: 'claimed' })
    expect(second.status).toBe(409)
  })
})
