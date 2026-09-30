// The viewer's remaining outbound decisions (slice B-wire): plain functions over plain data, no
// React, no DOM, no globals — the component only calls these and executes the result. Extracted
// for the same reason lib/commentPopover.ts was: each used to be an inline decision in viewer.tsx
// that a typo or a hardcoded stand-in could silently break with the whole suite staying green.

/** Deep-link URL → rail-open decision (slice C1a). `review=1` is baked into ALREADY-SENT Slack
 *  messages and notification-bell links — it must open the rail forever, so it's a permanent
 *  alias here, not a migration — the param outlived the mode it was named after. Anything else
 *  (missing, `review=0`, `review=yes`, …) is not truthy-coerced — only the documented `1` counts,
 *  everything else means "don't open". */
export function railFromSearch(params: URLSearchParams): boolean {
  return params.get('review') === '1'
}

// Media comments are ready without an iframe load event.
export function deepLinkReady({
  isMedia,
  loaded,
  hasThread,
}: {
  isMedia: boolean
  loaded: boolean
  hasThread: boolean
}): boolean {
  return hasThread && (isMedia || loaded)
}

/** A reveal request for ReviewRail's deep-link / anchor-click focus: `id` is WHICH thread, `nonce` a
 *  caller-bumped counter. The rail used to guard on id alone (`revealedRef.current === id`), so
 *  asking to reveal the SAME thread a second time was silently a no-op — invisible while only a
 *  one-shot page-load deep link could fire it, but wrong the moment clicking a highlight can request
 *  the same thread repeatedly. Gating on the NONCE instead means "reveal again" is "bump the nonce",
 *  even for an unchanged id — while an unchanged nonce across an unrelated re-render is still a
 *  no-op, preserving the property the old ref was protecting. */
export type RevealRequest = { id: string; nonce: number }

export function shouldReveal(
  request: RevealRequest | null,
  lastHandledNonce: number | null,
  hasTarget: boolean,
): boolean {
  if (!request || !hasTarget) return false
  return request.nonce !== lastHandledNonce
}

/** True once `el` occupies space. React can commit a ThreadCard (so `getElementById` succeeds) a
 *  frame before layout assigns it a box — `scrollIntoView` / `scrollTo` on a 0×0 node is a silent
 *  no-op, and if the reveal poll stops there the card never moves. */
export function isLaidOut(el: HTMLElement): boolean {
  if (el.offsetHeight > 0 || el.offsetWidth > 0) return true
  const box = el.getBoundingClientRect()
  return box.height > 0 || box.width > 0
}

/** Scroll a thread card inside the rail's overflow scroller. `scrollIntoView` walks EVERY scroll
 *  ancestor (including the window) and is cancelled by a competing smooth-scroll — on a nested
 *  `overflow-y-auto` rail that often looks like "the tab switched and nothing moved". Scrolling
 *  the marked scroller directly is the one motion the user can see.
 *
 *  Instant + `block: start`: a long resolved list makes `behavior: 'smooth'` crawl, and centering
 *  the card in the viewport leaves it looking like "some comment in the middle" rather than the
 *  one the click just named. */
export function scrollCardIntoRail(el: HTMLElement): void {
  const scroller = el.closest('[data-rail-scroll]')
  if (!(scroller instanceof HTMLElement)) {
    el.scrollIntoView({ block: 'start', behavior: 'auto' })
    return
  }
  const elBox = el.getBoundingClientRect()
  const scrollerBox = scroller.getBoundingClientRect()
  const top = scroller.scrollTop + (elBox.top - scrollerBox.top)
  scroller.scrollTo({ top, behavior: 'auto' })
}

/** Retry `find` across successive scheduled frames until it returns an element, then `apply` it
 *  once and stop. A single frame is NOT enough to assume the just-requested re-render (e.g. the
 *  rail's filter-tab switch, ReviewRail's own reveal effect) has committed: React can defer a
 *  heavier render (a resolved tab with a dozen-plus threads, each a full ThreadCard) past the very
 *  next `requestAnimationFrame`, so a one-shot `getElementById` finds nothing and the reveal-scroll
 *  silently no-ops forever — the exact bug this replaces. Bounded by a TIME budget (`maxWaitMs`),
 *  not a frame count: a fixed attempt count is a magic number tuned to whatever render weight was
 *  being tested at the time, and silently under-budgets again as more threads accumulate on a site
 *  (this is what happened to the original `maxAttempts=10` version — plausible for a couple of test
 *  threads, too tight for a resolved tab with over a dozen real ones). A genuinely absent target (a
 *  caller bug, not a slow render) still gives up once the deadline passes instead of polling
 *  forever. `schedule`/`cancel`/`now` are all injected (real code passes
 *  `requestAnimationFrame`/`cancelAnimationFrame`/`performance.now`) so this stays DOM/timing-free
 *  and unit-testable with a fake scheduler and clock. Returns a disposer for the caller's effect
 *  cleanup. */
export function pollUntilFound<T>(
  find: () => T | null | undefined,
  apply: (found: T) => void,
  schedule: (cb: () => void) => number,
  cancel: (handle: number) => void,
  maxWaitMs = 2000,
  now: () => number = () => performance.now(),
): () => void {
  let handle: number | null = null
  const deadline = now() + maxWaitMs
  const tick = (): void => {
    const found = find()
    if (found) {
      apply(found)
      return
    }
    if (now() >= deadline) return
    handle = schedule(tick)
  }
  handle = schedule(tick)
  return () => {
    if (handle !== null) cancel(handle)
  }
}
