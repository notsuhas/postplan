import { FRAME_NONCE_PARAM } from '../../../shared/frame'
import { useViewerComments } from '@/hooks/useViewerComments'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { type LoaderFunctionArgs, useLoaderData, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { api, ApiError } from '@/lib/api'
import { isAudioFile } from '@/lib/audio'
import { isImageFile } from '@/lib/image'
import { isVideoFile, isWebmFile } from '@/lib/video'
import { useHasVideoTrack } from '@/hooks/useHasVideoTrack'
import { ImageView } from '@/components/viewer/ImageView'
import { VideoView } from '@/components/viewer/VideoView'
import { attachDbBroker } from '@/lib/dbBroker'
import { comments, paintAnchors, type PendingAnchor, pendingToInput, type Thread } from '@/lib/comments'
import { feedback } from '@/lib/feedback'
import { type Anchor, initialPopover, stepPopover } from '@/lib/commentPopover'
import { askStream } from '@/lib/ask'
import { createFrameChannel } from '@/lib/frameChannel'
import { type Intent, parseIntent } from '@/lib/parseIntent'
import { encodePathSegments } from '@/lib/paths'
import { recordVisit } from '@/lib/recents'
import type { Me } from '@/lib/types'
import { deepLinkReady, railFromSearch, type RevealRequest } from '@/lib/viewerCommands'
import { loadViewer, type PrefetchResult, type ViewerLoaderData } from '@/lib/viewerLoader'
import { AudioView } from '@/components/viewer/AudioView'
import { Spinner } from '@/components/ui/states'
import { CommandPalette } from '@/components/layout/CommandPalette'
import { ViewerTopBar } from '@/components/viewer/ViewerTopBar'
import { CommentPopover } from '@/components/review/CommentPopover'
import { ReviewRail } from '@/components/review/ReviewRail'
import { ViewerSidebar } from '@/components/viewer/ViewerSidebar'

// The loader resolves on SITE META alone; the comments prefetch for the predicted entry file
// is fired unawaited and rides along as a pending promise — the iframe never waits on comments.
// All the logic (401 redirect, no-prefetch-on-meta-failure, null-entry root) lives in
// lib/viewerLoader where it's unit-tested.
export async function loader({ params, request }: LoaderFunctionArgs) {
  return loadViewer({ space: params.space ?? '', site: params.site ?? '', sitePath: params['*'] ?? '', request })
}

// The recents sidebar lets a user jump straight from one open site to another via a plain
// react-router <Link> (no full reload) — the FIRST in-app case of navigating between two mounts of
// this same route. React Router keeps one component instance across param changes on a matched
// route, so without a remount all the per-site useState (threads, filePath, loaded, railOpen, …)
// would leak from the old site into the new one. `key`-ing on space/site forces a clean remount on
// cross-site navigation while leaving same-site file navigation (the splat changing) alone — that
// case already reacts via the `src` memo below.
export function Component() {
  const params = useParams()
  return <Viewer key={`${params.space}/${params.site}`} />
}

function Viewer() {
  const { site, entryPath, commentsPromise } = useLoaderData() as ViewerLoaderData

  // Optional in-site file path from the route splat (`/space/site/docs/page.html`). Appended to the
  // content URL so a deep link / the directory-listing fallback opens that specific file; '' = root.
  const sitePath = useParams()['*'] ?? ''
  const [searchParams] = useSearchParams()
  const wantRailOpen = railFromSearch(searchParams)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  // Latest file path reported by the iframe's 'ready' intent, stashed unconditionally so the
  // me-resolution effect below can flush it even when 'ready' beats the /api/auth/me fetch on a
  // fresh load (see the recordVisit gate in the intent handler). NOT arbiter.current.readyPath:
  // that resets to null on navReset, and this deliberately survives it so the OLD file's genuine
  // visit still flushes when Me resolves after a splat nav.
  const lastReadyPathRef = useRef<string | null>(null)
  // Per-mount secret the db broker requires in the hello; it rides the frame URL so only this site's pages hold it.
  const [frameNonce] = useState(() => crypto.randomUUID().replaceAll('-', ''))
  const src = useMemo(() => {
    const contentUrl = appendPath(site.contentUrl, sitePath)
    return withAnnotate(contentUrl, frameNonce)
  }, [site.contentUrl, sitePath, frameNonce])
  // Bumped each time a page in the frame proves the nonce, so per-page state (paint, mode) is re-sent.
  const [frameEpoch, setFrameEpoch] = useState(0)
  const [channel] = useState(() =>
    createFrameChannel({
      nonce: frameNonce,
      getSource: () => iframeRef.current?.contentWindow,
      onConnect: () => setFrameEpoch((n) => n + 1),
    }),
  )
  // Layout effects run in the same task as the commit that inserts the iframe, so the listener exists
  // before the frame can possibly post its one-shot hello.
  useLayoutEffect(() => {
    window.addEventListener('message', channel.onWindowMessage)
    return () => {
      window.removeEventListener('message', channel.onWindowMessage)
      channel.dispose()
    }
  }, [channel])
  // `entryPath` (loader-resolved via resolveEntryPath, mirroring the server's normalizePath) is
  // the concrete file this URL serves — at the root that's the API's indexPath (root index.html or
  // the lone-upload fallback, e.g. recording.webm), so audio detection, the player src, and comment
  // anchoring work at the root URL too. null = the site has no known root entry (never guess).
  // Audio has no HTML document to frame — it gets a native player instead of the sandboxed
  // iframe, and (unlike the iframe src) no ?postplan_annotate param: that flag only triggers the
  // HTML-injection transform in content.ts, which never applies to audio.
  const mediaSrc = useMemo(() => appendPath(site.contentUrl, entryPath ?? ''), [site.contentUrl, entryPath])
  // .webm is either a voice note or a video; hold the player until the probe knows which.
  const webmHasVideo = useHasVideoTrack(entryPath !== null && isWebmFile(entryPath) ? mediaSrc : null)
  const isProbing = webmHasVideo === null
  const isVideo = entryPath !== null && (isVideoFile(entryPath) || webmHasVideo === true)
  const isAudio = !isVideo && !isProbing && entryPath !== null && isAudioFile(entryPath)
  const isImage = entryPath !== null && isImageFile(entryPath)
  const isMedia = isAudio || isVideo || isImage || isProbing

  // Is the comments rail on screen. It gates the on-page HIGHLIGHTS again (the rail is the panel
  // that explains them, so they live and die with it) but NOT commenting: selecting text still
  // composes in place with the panel closed.
  const [railOpen, setRailOpen] = useState(wantRailOpen)
  const [mode, setMode] = useState<'experience' | 'comment'>(wantRailOpen ? 'comment' : 'experience')
  const [loaded, setLoaded] = useState(false)
  const [me, setMe] = useState<Me | null>(null)
  // Stable site ref for fetches: slugs never change within a mount (Component keys on them).
  const siteRef = useMemo(
    () => ({ spaceSlug: site.spaceSlug, siteSlug: site.siteSlug }),
    [site.spaceSlug, site.siteSlug],
  )

  const {
    threads,
    setThreads,
    resolvedFilePath,
    dispatch,
    loadThreads,
    typing,
    sendTyping,
    sendTypingStop,
    refreshUnlessPushed,
  } = useViewerComments(siteRef, entryPath, isMedia, site.authenticated)
  // The HTML iframe only learns its file path from the annotate client's 'ready' postMessage
  // (never fires for non-HTML) — `filePath` below is what the rest of the viewer (comments,
  // rail) actually reads; for audio there's no message to wait for, so it's the splat itself.
  const filePath = isMedia ? entryPath : resolvedFilePath
  // A TEXT selection now comments in place, not in the rail: lib/commentPopover owns the
  // whole chip → composer → save lifecycle and this only executes it. Held with useReducer rather
  // than the arbiter's ref, because unlike the arbiter every transition here IS the UI.
  const [popover, dispatchPopover] = useReducer(stepPopover, undefined, initialPopover)
  // `dirty` is a reducer INPUT, read at dispatch time from a ref: the draft stays inside the
  // Composer (Composer.onDirtyChange), and a re-render per keystroke would buy nothing.
  const dirtyRef = useRef(false)
  const onDirtyChange = useCallback((d: boolean) => {
    dirtyRef.current = d
  }, [])
  // The rail composer, now only ever the page anchor — element comments are handled by the popover. Note
  // this is INDEPENDENT of `popover` above: neither clears the other, so both can be open at once.
  // That is why the rail offers a page comment behind a button rather than an always-open textarea
  // — an always-open one would make two live drafts the norm, not the exception.
  const [composing, setComposing] = useState<PendingAnchor | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [cmdOpen, setCmdOpen] = useState(false)
  // Paint anchors back into the iframe via the trusted parent→child channel. A paint IS the
  // highlight now (client.ts lights everything it's sent), so this is gated on `railOpen`: open the
  // panel and every commented passage lights up, close it and the EMPTY paint below clears the page
  // — the reader gets the document exactly as its author wrote it. The text-vs-element mapping (and
  // that an existing element thread still reaches the iframe) is lib/comments' paintAnchors,
  // unit-tested there — this is only the postMessage wiring.
  // `frameEpoch` is a DEPENDENCY, not just a guard: a paint sent before the page connects is dropped,
  // and each newly connected page (in-frame navigation) needs its own.
  const paint = useCallback(() => {
    if (!frameEpoch) return
    channel.send({ type: 'postplan:paint', anchors: railOpen && mode === 'comment' ? paintAnchors(threads) : [] })
  }, [threads, railOpen, mode, frameEpoch, channel])

  useEffect(() => {
    if (!frameEpoch || isMedia) return
    channel.send({ type: 'postplan:mode', mode })
    if (mode === 'experience') dispatchPopover({ type: 'dismiss' })
  }, [channel, isMedia, frameEpoch, mode])

  // The ask panel's one streaming call. Stable on siteRef alone — the question/anchor/token-sink/
  // signal all come from the caller, so this never needs to change identity within a mount.
  const onAsk = useCallback(
    (question: string, anchor: Anchor, onToken: (text: string) => void, signal: AbortSignal) =>
      askStream(siteRef, { question, quote: anchor.quote, blockText: anchor.blockText }, onToken, signal),
    [siteRef],
  )

  const sendFeedback = useCallback(
    async (commentIds?: string[]) => {
      try {
        const batch = commentIds ? await feedback.send(siteRef, commentIds) : await feedback.sendAllOpen(siteRef)
        toast.success(`${batch.items.length} comments queued`, {
          duration: Math.max(0, Date.parse(batch.claimableAt) - Date.now()),
          action: {
            label: 'Undo',
            onClick: () => {
              void feedback
                .undo(siteRef, batch.id)
                .catch((error: unknown) =>
                  toast.error(error instanceof ApiError ? error.message : 'Could not undo feedback send'),
                )
            },
          },
        })
      } catch (error) {
        toast.error(error instanceof ApiError ? error.message : 'Could not queue feedback')
        throw error
      }
    },
    [siteRef],
  )

  // Actionable count for the toolbar badge: open threads (mirrors the rail's default "open" list).
  const openCount = useMemo(() => threads.filter((t) => t.status === 'open').length, [threads])

  // Per-site tab title: without this the shell's static <title> ("Postplan — …") shows for EVERY
  // site. site.title is owner-set or deploy-derived from the entry HTML's <title>; fall back to
  // the slug. Restored on unmount so back-navigation to the dashboard keeps the shell default.
  useEffect(() => {
    const prev = document.title
    document.title = site.title ?? site.siteSlug
    return () => {
      document.title = prev
    }
  }, [site.title, site.siteSlug])

  // postplan.db credential broker: the injected SDK in the iframe hands us a MessagePort; we
  // execute its data-plane requests with OUR token so no credential ever enters the untrusted
  // frame. Bound to THIS site — the page cannot ask for another site's data.
  useLayoutEffect(() => {
    if (!site.authenticated) return
    const broker = attachDbBroker({
      site: { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug },
      nonce: frameNonce,
      getSource: () => iframeRef.current?.contentWindow,
    })
    return broker.dispose
  }, [site.authenticated, site.spaceSlug, site.siteSlug, frameNonce])

  // The rail's reveal has two producers: the one-shot deep link below and clicks on a painted
  // highlight. A click is the source the nonce was built for — the same thread can be clicked over
  // and over, and each click must reveal again, so the counter (not the thread id) is what changes.
  // Once a click has happened it wins for the rest of the page's life; the deep link fires at most
  // once, at mount, before any click can have landed.
  const [clickFocusRequest, setClickFocusRequest] = useState<RevealRequest | null>(null)
  const clickRevealNonce = useRef(0)
  const revealThread = useCallback((thread: Thread) => {
    setRailOpen(true)
    clickRevealNonce.current += 1
    setClickFocusRequest({ id: thread.id, nonce: clickRevealNonce.current })
  }, [])

  // Intents from the connected page. parseIntent is a shape filter, not a trust oracle — nothing
  // here writes without a subsequent explicit user action.
  useEffect(() => {
    function onMsg(data: unknown) {
      const intent: Intent | null = parseIntent(data)
      if (!intent) return
      if (intent.type === 'ready') {
        // Audio has no iframe/'ready'; for HTML this is where the SPA learns the current file.
        // The arbiter arbitrates: a matching ready applies the parked prefetch, a mismatch discards
        // it and orders a fresh fetch, a duplicate or a stale ready (old iframe doc after a splat
        // nav) is ignored outright — including for recordVisit below.
        const { state, decision } = dispatch({ type: 'ready', path: intent.filePath })
        if (decision.kind === 'refetch') loadThreads(decision.path)
        // 'ignore' covers duplicates too — a duplicate ready no longer double-counts a visit.
        if (decision.kind === 'ignore') return
        if (state.readyPath !== intent.filePath) return
        lastReadyPathRef.current = intent.filePath
        // Every in-iframe navigation fires 'ready' with the real current file — the only place the
        // SPA learns it, since the URL doesn't change on in-page navigation. Skip until Me resolves
        // (never record to an unknown/shared-machine user); the me-effect below flushes the ref once
        // Me resolves, so a 'ready' that beats the /api/auth/me fetch on a fresh load isn't dropped.
        if (me)
          recordVisit(me.id, {
            spaceSlug: site.spaceSlug,
            siteSlug: site.siteSlug,
            title: site.title,
            filePath: intent.filePath,
          })
      }
      // Comment mode accepts selections even while the rail is closed — a text selection feeds the popover reducer (chip first, composer only on an
      // explicit click) whether or not the rail panel happens to be visible.
      else if (
        mode !== 'comment' ||
        (!site.authenticated && intent.type !== 'anchorClick' && intent.type !== 'anchorStatus')
      )
        return
      else if (intent.type === 'select')
        dispatchPopover({
          type: 'select',
          // A rect is what the chip is pinned to. parseIntent leaves it optional (our own annotate
          // client always sends one), so a message without one still gets a chip — at the frame's
          // top-left, clickable — rather than silently losing the selection.
          anchor: {
            quote: intent.quote,
            context: intent.context,
            rect: intent.rect ?? { top: 0, left: 0, width: 0, height: 0 },
            blockText: intent.blockText,
          },
          dirty: dirtyRef.current,
        })
      else if (intent.type === 'clear') dispatchPopover({ type: 'clear' })
      // Neither of these is observable from the parent: they happen inside a cross-origin document.
      else if (intent.type === 'clickAway') dispatchPopover({ type: 'clickAway', dirty: dirtyRef.current })
      else if (intent.type === 'escape') dispatchPopover({ type: 'dismiss' })
      // Nor is a keystroke inside the frame — the reason ⌘K doesn't work there either. The reducer
      // is the authority on whether this opens anything.
      else if (intent.type === 'commentKey') dispatchPopover({ type: 'commentKey' })
      // Same contract as commentKey, for the ask panel's own shortcut.
      else if (intent.type === 'askKey') dispatchPopover({ type: 'askKey' })
      // A click on a painted highlight — the page→rail direction. The id is looked up in OUR
      // threads (a forged one matches nothing and reveals nothing), and the rail is necessarily
      // already open, since nothing is painted while it's closed.
      else if (intent.type === 'anchorClick') {
        const target = threads.find((t) => t.id === intent.id)
        if (target) revealThread(target)
      } else if (intent.type === 'anchorStatus') {
        const resolved = new Set(intent.resolved)
        const orphaned = new Set(intent.orphaned)
        setThreads((current) =>
          current.map((thread) =>
            orphaned.has(thread.id)
              ? { ...thread, anchorStatus: 'orphaned' }
              : resolved.has(thread.id)
                ? { ...thread, anchorStatus: 'anchored' }
                : thread,
          ),
        )
      }
    }
    return channel.subscribe(onMsg)
  }, [
    channel,
    me,
    site.authenticated,
    site.spaceSlug,
    site.siteSlug,
    site.title,
    threads,
    dispatch,
    loadThreads,
    setThreads,
    revealThread,
    mode,
  ])

  useEffect(() => {
    if (!site.authenticated) return
    api
      .get<Me>('/api/auth/me')
      .then((m) => {
        setMe(m)
        // Site-level visit (filePath '') — recorded once Me is known, independent of any in-iframe
        // navigation (which may never report a file, e.g. a single-page site with no postMessage).
        recordVisit(m.id, { spaceSlug: site.spaceSlug, siteSlug: site.siteSlug, title: site.title, filePath: '' })
        // Flush whatever file the iframe already reported ready for — on a fresh load 'ready' usually
        // beats this fetch, and the intent handler's `if (me)` gate above would otherwise drop it.
        if (lastReadyPathRef.current) {
          recordVisit(m.id, {
            spaceSlug: site.spaceSlug,
            siteSlug: site.siteSlug,
            title: site.title,
            filePath: lastReadyPathRef.current,
          })
        }
      })
      .catch(() => setMe(null))
  }, [site.authenticated, site.spaceSlug, site.siteSlug, site.title])

  // Consume the loader's prefetch + reset on splat navigation (viewer → another file in the SAME
  // site; cross-site nav remounts via the Component key). A nav brings the loading overlay back and
  // clears per-file state, and the arbiter reset makes any in-flight result or late ready from the
  // OLD file inert. Each loader run yields a fresh commentsPromise — consumed exactly once (by
  // identity), so revalidations can't double-start a load. Threads then reach state only through
  // arbiter decisions: prefetch apply (HTML on matching ready, audio on settle), ready-driven
  // refetch, or mutation refresh — powering the toolbar badge before review opens and seeding the
  // rail, which stays fresh via onCreate/onChanged.
  const prevSitePath = useRef(sitePath)
  const consumedPrefetch = useRef<Promise<PrefetchResult> | null>(null)
  useEffect(() => {
    if (prevSitePath.current !== sitePath) {
      prevSitePath.current = sitePath
      dispatch({ type: 'navReset', expected: entryPath })
      setThreads([])
      setComposing(null)
      dispatchPopover({ type: 'dismiss' }) // a chip/popover pinned to the OLD document's rect
      setLoaded(false)
    }
    if (commentsPromise && commentsPromise !== consumedPrefetch.current && entryPath !== null) {
      consumedPrefetch.current = commentsPromise
      // HTML stays provisional until its postplan:ready confirms the path; audio has no iframe (and
      // thus no ready) — it applies as soon as it settles, keeping the audio player's rail working.
      loadThreads(entryPath, { provisional: !isMedia, prefetch: commentsPromise })
    }
  }, [sitePath, entryPath, commentsPromise, isMedia, dispatch, loadThreads, setThreads])

  useEffect(paint, [paint])

  // The rail's "Add comment" button starts a bare page-anchored composer directly (no selection
  // step) — for every content type, not just audio. Audio NEEDS it (there is no DOM to
  // select in); everywhere else it is how you say something about the page as a whole rather than
  // about one arbitrary sentence. Text selection still composes in the popover, untouched.
  const startPageComment = useCallback(() => {
    setMode('comment')
    setComposing({ kind: 'page' })
  }, [])

  // Read on demand (an event handler, not a subscription) — never causes a re-render, so the
  // timestamp button always inserts whatever the player's position is AT CLICK TIME with no
  // state/effect plumbing.
  const getCurrentTime = useCallback(() => (videoRef.current ?? audioRef.current)?.currentTime ?? 0, [])

  // ⌘K / Ctrl-K opens the command palette here too, mirroring the AppShell dashboard chrome.
  // (Keydown only reaches the parent when focus is outside the sandboxed iframe; the header
  // Search button is the always-available fallback.)
  useEffect(() => {
    if (!site.authenticated) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [site.authenticated])

  // Scroll an anchor into view in the iframe: element → its selector; text → its quote. What a rail
  // card's click does; nothing about it changes what is LIT, because everything already is for as
  // long as the rail is open.
  const scrollAnchor = useCallback(
    (thread: Thread) => {
      if (thread.anchorType === 'element' && thread.anchor)
        channel.send({ type: 'postplan:focus', selector: thread.anchor.selector })
      // Context rides along so focusing lands on the SAME occurrence the paint highlighted.
      else if (thread.quote) channel.send({ type: 'postplan:focus', quote: thread.quote, context: thread.context })
    },
    [channel],
  )

  // Deep-link contract (a notification click lands here): `?review=1` opens the rail forever — it's
  // baked into ALREADY-SENT Slack messages and notification-bell links, so it's a permanent alias
  // (railFromSearch), not a migration — and `?thread=<id>` focuses that thread — scroll the iframe
  // to its anchor + its rail card into view, once the frame is loaded and that file's threads are
  // in. `filePath` in the notification's URL path ensures the right file (and thus the thread) is
  // what loads. Fires at most once.
  const deepLinkThreadId = searchParams.get('thread')
  const deepLinkFocused = useRef(false)

  useEffect(() => {
    if (wantRailOpen) setRailOpen(true)
  }, [wantRailOpen])

  useEffect(() => {
    const target = threads.find((t) => t.id === deepLinkThreadId)
    // Readiness differs by content kind (lib/viewerCommands' deepLinkReady): an HTML
    // page waits on the iframe's `loaded` onLoad; audio renders no iframe, so `loaded` never fires
    // and gating on it left `?thread=` on an audio page permanently dead — audio is ready as soon
    // as its thread has arrived.
    if (
      deepLinkFocused.current ||
      !deepLinkThreadId ||
      !railOpen ||
      !deepLinkReady({ isMedia, loaded: frameEpoch > 0, hasThread: !!target })
    )
      return
    deepLinkFocused.current = true
    // Scroll the iframe to the anchor; the rail reveals + scrolls the thread card itself (ReviewRail
    // owns the open/resolved filter, so it can un-hide a resolved target).
    scrollAnchor(target!)
  }, [deepLinkThreadId, railOpen, frameEpoch, isMedia, threads, scrollAnchor])

  // Stable identity for ReviewRail's focusRequest prop: an inline object literal here would be a
  // NEW reference on every viewer render (threads loading, `loaded` flipping, …), and ReviewRail's
  // reveal effect is keyed on `[focusRequest, threads]` — so every unrelated re-render would re-run
  // it, whose cleanup cancels the pending rAF card-scroll before it fires, and the re-run then
  // no-ops on the (nonce-)unchanged request. Memoized on the one thing that should actually change
  // it: the deep link's own id (nonce is a constant 0 here — see the comment on ReviewRail's
  // focusRequest prop below).
  const deepLinkFocusRequest = useMemo(
    () => (deepLinkThreadId ? { id: deepLinkThreadId, nonce: 0 } : null),
    [deepLinkThreadId],
  )

  // The one create path, text and voice alike, rail and popover alike — hence the anchor is an
  // ARGUMENT: the rail's page/element anchor and the popover's text anchor drive the same write.
  // It REJECTS on every failure — no anchor yet, or the write itself failing. The composer treats a
  // resolved onSubmit as success and clears the draft, so anything that resolves without having
  // written destroys what the user typed (or recorded). Toast for the human, rethrow for the
  // composer. `onWritten` closes whichever composer started it, before the list refresh it awaits.
  // `filePath` is null until the iframe reports ready.
  async function submitThread(
    failMsg: string,
    anchor: PendingAnchor | null,
    write: (path: string, anchor: PendingAnchor) => Promise<unknown>,
    onWritten: () => void,
  ) {
    if (!filePath || !anchor) {
      toast.error('This page is still loading — try again in a moment')
      throw new Error('no anchor to comment on yet')
    }
    try {
      await write(filePath, anchor)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : failMsg)
      throw err
    }
    onWritten()
    // Adding a comment OPENS the rail — always. The new thread's own card appearing there is the
    // confirmation (and its highlight lighting up on the page), so there is no toast: a toast was
    // only ever standing in for a panel that wasn't allowed to open itself. Already open is a no-op.
    setRailOpen(true)
    // A create is pushed, so with a live stream this read goes away (see refreshUnlessPushed).
    await refreshUnlessPushed(filePath, true)
  }

  const createThread = (body: string, mentions: string[]) =>
    submitThread(
      'Failed to add comment',
      composing,
      (path, anchor) => comments.create(site, pendingToInput(path, body, anchor), mentions),
      () => setComposing(null),
    )

  // Voice sibling: the anchor fields come from the same pending anchor (body is the server-side
  // transcript, so it's dropped from the multipart payload).
  const createVoiceThread = (blob: Blob) =>
    submitThread(
      'Failed to add voice comment',
      composing,
      (path, anchor) => {
        const { body: _body, ...fields } = pendingToInput(path, '', anchor)
        return comments.createVoice(site, blob, fields)
      },
      () => setComposing(null),
    )

  // The popover's half of the same path: its anchor is the open composer's text anchor, and the
  // reducer — not this — decides what a settle closes, so both outcomes are reported to it.
  async function popoverWrite(run: (anchor: PendingAnchor, onWritten: () => void) => Promise<void>) {
    const open = popover.composer
    if (!open) return
    dispatchPopover({ type: 'submit' })
    try {
      await run({ kind: 'text', quote: open.anchor.quote, context: open.anchor.context }, () =>
        dispatchPopover({ type: 'saveSettled', id: open.id, ok: true }),
      )
    } catch (err) {
      dispatchPopover({ type: 'saveSettled', id: open.id, ok: false })
      throw err // a failed write keeps the popover open on its draft — see submitThread
    }
  }

  const createPopoverThread = (body: string, mentions: string[]) =>
    popoverWrite((anchor, onWritten) =>
      submitThread(
        'Failed to add comment',
        anchor,
        (path, a) => comments.create(site, pendingToInput(path, body, a), mentions),
        onWritten,
      ),
    )

  const createPopoverVoiceThread = (blob: Blob) =>
    popoverWrite((anchor, onWritten) =>
      submitThread(
        'Failed to add voice comment',
        anchor,
        (path, a) => {
          const { body: _body, ...fields } = pendingToInput(path, '', a)
          return comments.createVoice(site, blob, fields)
        },
        onWritten,
      ),
    )

  // Closes the rail panel — via the Comments toggle or the rail's own ✕ — and clears the rail's own
  // page-anchor composer with it. The on-page highlights go too, but not from here: `railOpen` is a
  // dependency of `paint`, so flipping it re-runs that effect with an empty anchor list. It does NOT
  // touch the popover (dispatchPopover) — that used to be safe because the popover was ALSO gated on
  // review and unmounted the moment review ended; now it's unconditional (C2b), so dismissing it
  // here would destroy an unrelated in-progress draft just because the user closed the rail panel.
  // The popover has its own explicit teardown (Escape / click-away / save).
  function closeRail() {
    setRailOpen(false)
    setComposing(null)
  }

  const toggleRail = () => {
    if (railOpen) closeRail()
    else {
      setMode('comment')
      setRailOpen(true)
    }
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-background">
      <ViewerTopBar
        site={site}
        sitePath={sitePath}
        railOpen={railOpen}
        commentCount={openCount}
        onToggleRail={toggleRail}
        onToggleSidebar={() => setSidebarOpen((o) => !o)}
        onSearch={() => setCmdOpen(true)}
        mode={mode}
        onModeChange={setMode}
        // Print rides the annotate client's command channel; audio has no document to print.
        onPrint={isMedia ? undefined : () => channel.send({ type: 'postplan:print' })}
      />

      {site.authenticated && <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} user={me} />}

      {site.authenticated && (
        <ViewerSidebar
          open={sidebarOpen}
          onOpenChange={setSidebarOpen}
          userId={me?.id ?? null}
          currentSpaceSlug={site.spaceSlug}
          currentSiteSlug={site.siteSlug}
        />
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* The loading overlay lives inside this wrapper so its coords match the iframe viewport. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 justify-center bg-muted/20">
          <div className="relative h-full w-full">
            {isProbing ? (
              <div className="flex size-full items-center justify-center">
                <Spinner className="size-6" />
              </div>
            ) : isAudio ? (
              <AudioView src={mediaSrc} fileName={(entryPath ?? '').split('/').pop() ?? ''} audioRef={audioRef} />
            ) : isVideo ? (
              <VideoView
                key={mediaSrc}
                src={mediaSrc}
                fileName={(entryPath ?? '').split('/').pop() ?? ''}
                videoRef={videoRef}
              />
            ) : isImage ? (
              <ImageView key={mediaSrc} src={mediaSrc} fileName={(entryPath ?? '').split('/').pop() ?? ''} />
            ) : (
              <iframe
                ref={iframeRef}
                // Hosted HTML is rendered on a stable WHITE canvas (the browser's default page
                // background that every uploaded document assumes), not the app's dark background,
                // so a doc with hardcoded dark text
                // and no background of its own showed dark-on-dark (invisible). A doc that designs
                // itself dark still paints over this white with its own background. colorScheme:light
                // keeps native controls/scrollbars consistent with the light canvas.
                className="size-full border-0 bg-white"
                style={{ colorScheme: 'light' }}
                src={src}
                title={site.title ?? site.siteSlug}
                onLoad={() => setLoaded(true)}
                // allow-top-navigation-by-user-activation: lets the directory-listing links (target=_top)
                // break out to the app route on a user click, so the address bar updates. Gesture-gated,
                // so iframed content can't silently redirect the tab.
                // allow-popups + allow-popups-to-escape-sandbox: the content worker rewrites external
                // links (other origins) to target=_blank; these two flags let that click open a REAL
                // new tab that isn't itself sandboxed, so the destination site loads normally.
                // allow-modals: window.print() counts as a modal, and Chromium blocks it in a
                // sandboxed frame without this flag — required by the Print / Save as PDF action
                // (the annotate client's postplan:print handler). Also un-blocks alert()/confirm()
                // for hosted pages, which matches how interactive artifacts behave elsewhere.
                // No allow-same-origin: every page gets an opaque origin, so sites can't read or script each other.
                // Granted so copy buttons, fullscreen and video work; camera, mic and location stay off.
                allow="clipboard-write; fullscreen; autoplay; picture-in-picture"
                // Hides this entry's URL (and the broker nonce in it) from navigation.entries() of later pages.
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-top-navigation-by-user-activation allow-modals allow-downloads"
              />
            )}
            {/* Sibling of the iframe ON PURPOSE: this wrapper is the iframe's own box, so the rect
                the frame reports needs no translation to position the chip/popover over it.
                The POPOVER is unconditional on railOpen (C2b): anyone who can open the site can
                comment without opening a panel first. */}
            {site.authenticated && !isMedia && mode === 'comment' && (
              <CommentPopover
                chip={popover.chip}
                composer={popover.composer}
                ask={popover.ask}
                onActivate={() => dispatchPopover({ type: 'activate' })}
                onAskActivate={() => dispatchPopover({ type: 'askActivate' })}
                onDismiss={() => dispatchPopover({ type: 'dismiss' })}
                onSubmit={createPopoverThread}
                onSubmitVoice={createPopoverVoiceThread}
                onAsk={onAsk}
                loadMentions={() => comments.mentionable(site)}
                onDirtyChange={onDirtyChange}
              />
            )}
            {!isMedia && !loaded && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background text-muted-foreground">
                <Spinner className="size-6" />
                <span className="text-sm">Loading preview…</span>
              </div>
            )}
          </div>
        </div>

        {railOpen && (
          <ReviewRail
            site={site}
            me={me}
            threads={threads}
            composing={composing}
            onCancelComposer={() => setComposing(null)}
            onCreate={createThread}
            onCreateVoice={createVoiceThread}
            // ThreadCard fires this for resolve/reopen and delete as well as for replies, so the
            // gate is per change (`pushed`), not per call site: a reply's push replaces this read,
            // a resolve has no push and must keep it or it would be invisible until reload.
            onChanged={({ pushed }) => filePath && void refreshUnlessPushed(filePath, pushed)}
            onFocusAnchor={scrollAnchor}
            typing={typing}
            // The send side. `sendTyping` does its own 15s-per-thread rate cap — every
            // keystroke calls it and all but one is swallowed there, so the composer needs no timer
            // and no state of its own. With no live socket both are silent no-ops.
            onTyping={sendTyping}
            onTypingStop={sendTypingStop}
            onSendFeedback={site.authenticated ? sendFeedback : undefined}
            onClose={closeRail}
            onStartComment={startPageComment}
            getCurrentTime={isAudio || isVideo ? getCurrentTime : undefined}
            // Highlight clicks take over from the deep link once one has happened (see revealThread):
            // the link is one-shot at mount and carries a constant nonce, while a click re-requests
            // the same thread every time and bumps the nonce to say so. Both are stable references —
            // an inline literal here re-ran ReviewRail's reveal effect on every viewer render and
            // silently dropped the pending card scroll.
            focusRequest={clickFocusRequest ?? deepLinkFocusRequest}
          />
        )}
      </div>
    </div>
  )
}

function withAnnotate(u: string, frameNonce: string): string {
  const url = new URL(u)
  url.searchParams.set('postplan_annotate', '1')
  url.searchParams.set(FRAME_NONCE_PARAM, frameNonce)
  return url.toString()
}

// contentUrl always ends in `/` (…/space/site/ or …/_t/token/space/site/); append the in-site
// path so sub-resources still resolve relative to the site root. Each segment is encoded.
function appendPath(contentUrl: string, filePath: string): string {
  if (!filePath) return contentUrl
  return contentUrl + encodePathSegments(filePath)
}
