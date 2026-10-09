import { FRAME_HELLO } from '../../../shared/frame'

type Handler = (data: unknown) => void

/** The port from a hello the framed page posted; `trusted` only when it carries this mount's nonce. */
export function readHello(
  e: MessageEvent,
  opts: { type: string; nonce: string; getSource: () => Window | null | undefined },
): { port: MessagePort; trusted: boolean } | null {
  // Sandboxed pages have an opaque origin; the frame window and the nonce are what identify them.
  if (e.origin !== 'null') return null
  const source = opts.getSource()
  if (!source || e.source !== source) return null
  const hello = e.data as { type?: unknown; nonce?: unknown } | null
  if (hello?.type !== opts.type) return null
  const port = e.ports?.[0]
  return port ? { port, trusted: hello.nonce === opts.nonce } : null
}

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
      const hello = readHello(e, { type: FRAME_HELLO, nonce: opts.nonce, getSource: opts.getSource })
      if (!hello) return
      if (!hello.trusted) {
        hello.port.close()
        return
      }
      const p = hello.port
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
