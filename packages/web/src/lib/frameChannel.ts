import { FRAME_HELLO } from '../../../shared/frame'

type Handler = (data: unknown) => void

// The viewer's one trusted line to the framed page. The page runs on an opaque origin, so the
// window message's origin proves nothing; the nonce (only in the URL the viewer loaded) does.
export function createFrameChannel(opts: {
  nonce: string
  getSource: () => Window | null | undefined
  onConnect: () => void
}) {
  let port: MessagePort | null = null
  const handlers = new Set<Handler>()

  return {
    /** Adopts a port only from the frame window, carrying this mount's nonce. */
    onWindowMessage(e: MessageEvent) {
      const source = opts.getSource()
      if (!source || e.source !== source) return
      const hello = e.data as { type?: unknown; nonce?: unknown } | null
      if (hello?.type !== FRAME_HELLO || hello.nonce !== opts.nonce) return
      const p = e.ports?.[0]
      if (!p) return
      port?.close()
      port = p
      p.onmessage = (m) => {
        for (const h of handlers) h(m.data)
      }
      opts.onConnect()
    },
    /** Delivered to the current page only; dropped when no page has connected yet. */
    send(msg: unknown) {
      port?.postMessage(msg)
    },
    subscribe(handler: Handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    dispose() {
      port?.close()
      port = null
    },
  }
}
