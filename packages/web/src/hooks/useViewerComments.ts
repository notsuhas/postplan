import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ApiError } from '@/lib/api'
import { applyCommentEvent } from '@/lib/applyCommentEvent'
import { type CommentStream, type CommentStreamEvent, createCommentStream } from '@/lib/commentStream'
import { comments, type Thread } from '@/lib/comments'
import { type ArbiterEvent, type ArbiterState, type Decision, initialArbiter, stepArbiter } from '@/lib/prefetchArbiter'
import { PREFETCH_FAILED, type PrefetchResult } from '@/lib/viewerLoader'
import type { TypingPing } from '@/components/review/ReviewRail'

/** Coordinate list loads and socket events without letting stale responses replace newer comments. */
export function useViewerComments(
  siteRef: { spaceSlug: string; siteSlug: string },
  entryPath: string | null,
  isMedia: boolean,
  authenticated: boolean,
) {
  const [threads, setThreads] = useState<Thread[]>([])
  const [resolvedFilePath, setResolvedFilePath] = useState<string | null>(null)
  const filePath = isMedia ? entryPath : resolvedFilePath
  // List generations also arbitrate socket events received during an unsettled read.
  // Prefetch results stay provisional until the frame confirms its path. Generations discard
  // older requests after navigation or mutation refreshes.
  const arbiter = useRef<ArbiterState>(initialArbiter(entryPath))

  const applyDecision = useCallback((decision: Decision) => {
    if (decision.kind === 'apply') setThreads(decision.data)
    else if (decision.kind === 'error')
      toast.error(decision.error instanceof ApiError ? decision.error.message : 'Failed to load comments')
    // none / ignore / discard: stale or unconfirmed results die silently — never clear state,
    // never toast over a newer success. ('refetch' is handled at the ready dispatch site.)
  }, [])

  const dispatch = useCallback(
    (event: ArbiterEvent) => {
      const step = stepArbiter(arbiter.current, event)
      arbiter.current = step.state
      setResolvedFilePath(step.state.readyPath)
      applyDecision(step.decision)
      return step
    },
    [applyDecision],
  )

  // Start a comments load through the arbiter. `prefetch` adopts the loader's in-flight promise
  // (it never rejects — failures arrive as PREFETCH_FAILED); ad-hoc loads fetch here, and only a
  // CURRENT-generation failure surfaces (the reducer ignores stale rejections).
  const loadThreads = useCallback(
    (path: string, opts?: { provisional?: boolean; prefetch?: Promise<PrefetchResult> }) => {
      const { state } = dispatch({ type: 'start', path, provisional: opts?.provisional ?? false })
      const gen = state.inFlight?.gen
      if (gen === undefined) return Promise.resolve()
      // Returned so a mutation flow can await the refresh (keeps the composer busy until the list
      // is applied) — the chain itself never rejects, every outcome settles through the arbiter.
      if (opts?.prefetch) {
        return opts.prefetch.then((r) => {
          if (r === PREFETCH_FAILED) dispatch({ type: 'settled', gen, ok: false, error: null })
          else dispatch({ type: 'settled', gen, ok: true, data: r })
        })
      }
      return comments.list(siteRef, path).then(
        (data) => void dispatch({ type: 'settled', gen, ok: true, data }),
        (error: unknown) => void dispatch({ type: 'settled', gen, ok: false, error }),
      )
    },
    [dispatch, siteRef],
  )

  // Mutation refresh (create/reply/resolve): a fresh generation, so any older in-flight list
  // result — prefetch included — can no longer clobber what this returns.
  const refresh = useCallback((fp: string) => loadThreads(fp), [loadThreads])

  // Keep one socket per site; file navigation updates its callbacks through a ref.
  const streamRef = useRef<CommentStream | null>(null)
  // The socket is per SITE and outlives every in-iframe file change, so its callbacks read the
  // current file from a ref rather than closing over it: making `filePath` a dependency of the
  // effect below would re-dial on every in-page navigation and drop events for the redial's length.
  const filePathRef = useRef(filePath)
  useEffect(() => {
    filePathRef.current = filePath
  }, [filePath])

  // Who is replying right now. A ping carries its own ABSOLUTE expiry and is never retracted
  // (the room schedules nothing; a closed laptop just stops sending), so the rail counts it down on
  // its own clock and nothing here has to expire anything. Keyed by VIEWER: a person types in one
  // place at a time, so a new ping replaces that viewer's previous one — and any ping already past
  // its expiry is dropped on the way in, so this can't grow with the length of the session.
  const [typing, setTyping] = useState<TypingPing[]>([])

  const onPushed = useCallback(
    // Both frames the comments channel carries — the transport declares the union, so the
    // discriminant below is the only thing that tells them apart here.
    (event: CommentStreamEvent) => {
      if (event.type === 'typing') {
        // Destructured, never spread: ONLY these three fields cross into the rail, so a payload
        // that also carried a display name could not get it rendered.
        const { viewerId, threadId, expiresAt } = event
        const now = Date.now()
        setTyping((live) => {
          // Dropping this viewer's previous ping is what makes a stop (expiresAt 0) work: the ping
          // it replaces is gone, and an already-elapsed one is never added back — so the list holds
          // live pings only and cannot grow with the length of the session.
          const others = live.filter((p) => p.viewerId !== viewerId && p.expiresAt > now)
          return expiresAt > now ? [...others, { viewerId, threadId, expiresAt }] : others
        })
        return
      }
      // The fold goes THROUGH the arbiter rather than straight to setThreads: a push landing while a
      // list read is unsettled must be applied to the list that read returns (applying it now would
      // paint it onto a list the settle is about to replace — the comment would vanish). Only the
      // arbiter knows whether one is in flight, and which file it is for, so it holds the fold and
      // runs it at apply time. 'live' means nothing is unsettled: this is the on-screen list's file.
      const { decision } = dispatch({ type: 'push', apply: (list, path) => applyCommentEvent(list, event, path) })
      const fp = filePathRef.current
      if (decision.kind === 'live' && fp) setThreads((list) => decision.apply(list, fp))
    },
    [dispatch],
  )

  useEffect(() => {
    if (!authenticated) return
    const stream = createCommentStream({
      site: siteRef,
      appOrigin: window.location.origin,
      onEvent: onPushed,
      // There is no cursor to replay from , so a redial can only mean "a gap may
      // have happened" — including the one comment the 300s token expiry drops. Re-reading the list
      // is the whole convergence story.
      onReconnect: () => {
        const fp = filePathRef.current
        if (fp) void refresh(fp)
      },
    })
    streamRef.current = stream
    return () => {
      streamRef.current = null
      stream.dispose()
    }
    // All three are stable for the life of a mount (siteRef is memoized on slugs the Component keys
    // on), so this dials ONCE per site and disposes on unmount — never mid-session.
  }, [authenticated, siteRef, onPushed, refresh])

  // A local write's list refetch, dropped in exactly one case: the room fans this write back to
  // every socket on the site — the author's own included — so a PUSHED change on a CONNECTED stream
  // is already on its way and the read would only ask for what we are about to be told. Anything
  // else still reads: resolve/reopen/delete are never pushed, and with no live
  // socket (the redial gap, or realtime unavailable) the read is the only way the author ever sees
  // their own write. Returned so a mutation flow can keep its composer busy until the list lands.
  // Stable across renders so ReviewRail's own memoized children don't churn: the stream itself is
  // held in a ref precisely because it is replaced on redial, and neither of these should change
  // identity when it is.
  const sendTyping = useCallback((threadId: string) => streamRef.current?.sendTyping(threadId), [])
  const sendTypingStop = useCallback((threadId: string) => streamRef.current?.sendTypingStop(threadId), [])

  const refreshUnlessPushed = useCallback(
    (fp: string, pushed: boolean) => (pushed && streamRef.current?.connected() ? Promise.resolve() : refresh(fp)),
    [refresh],
  )

  return {
    threads,
    setThreads,
    resolvedFilePath,
    dispatch,
    loadThreads,
    refresh,
    typing,
    sendTyping,
    sendTypingStop,
    refreshUnlessPushed,
  }
}
