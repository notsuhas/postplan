import { api } from '@/lib/api'
import type { ViewerSite } from '@/lib/types'

export type FeedbackStatus = 'queued' | 'claimed' | 'completed' | 'cancelled'

export interface FeedbackBatch {
  id: string
  site: { space: string; slug: string }
  siteVersion: number
  status: FeedbackStatus
  claimableAt: string
  createdAt: string
  claimedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
  completedVersion: number | null
  items: Array<{
    commentId: string
    threadId: string
    page: string
    selector: string | null
    sourceContext: unknown
    anchorType: 'text' | 'page' | 'element'
    anchorStatus: 'anchored' | 'shifted' | 'suggested' | 'orphaned'
    quote: string | null
    author: { id: string | null; name: string }
    text: string
    version: number
    anchorVersion: number
    createdAt: string
  }>
}

type SiteRef = Pick<ViewerSite, 'spaceSlug' | 'siteSlug'>
const base = (site: SiteRef) => `/api/sites/${site.spaceSlug}/${site.siteSlug}/feedback`
const headers = (operation: string) => ({ 'Idempotency-Key': `${operation}-${crypto.randomUUID()}` })

export const feedback = {
  send: (site: SiteRef, commentIds: string[]) =>
    api.postWithHeaders<FeedbackBatch>(base(site), { commentIds }, headers('send')),
  sendAllOpen: (site: SiteRef) => api.postWithHeaders<FeedbackBatch>(base(site), { allOpen: true }, headers('send')),
  undo: (site: SiteRef, batchId: string) =>
    api.postWithHeaders<FeedbackBatch>(`${base(site)}/${batchId}/undo`, undefined, headers('undo')),
}
