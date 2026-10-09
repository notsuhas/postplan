import { describe, expect, test } from 'bun:test'
import { createFrameChannel } from '../frameChannel'

const frame = {} as Window
const other = {} as Window

function setup() {
  let connects = 0
  const channel = createFrameChannel({ nonce: 'n1', getSource: () => frame, onConnect: () => connects++ })
  const got: unknown[] = []
  channel.subscribe((d) => got.push(d))
  const hello = (over: { source?: Window; nonce?: unknown } = {}) => {
    const ch = new MessageChannel()
    channel.onWindowMessage({
      source: over.source ?? frame,
      data: { type: 'postplan:hello', nonce: 'nonce' in over ? over.nonce : 'n1' },
      ports: [ch.port2],
    } as unknown as MessageEvent)
    return ch.port1
  }
  return { channel, got, hello, connects: () => connects }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

describe('frame channel', () => {
  test('a hello from the frame with the nonce connects both directions', async () => {
    const { channel, got, hello, connects } = setup()
    const page = hello()
    const toPage: unknown[] = []
    page.onmessage = (e) => toPage.push(e.data)
    page.postMessage({ type: 'postplan:ready', filePath: 'index.html' })
    channel.send({ type: 'postplan:paint', anchors: [] })
    await tick()
    expect(connects()).toBe(1)
    expect(got).toEqual([{ type: 'postplan:ready', filePath: 'index.html' }])
    expect(toPage).toEqual([{ type: 'postplan:paint', anchors: [] }])
  })

  test.each([
    ['without the nonce (another site navigated into the frame)', { nonce: null }],
    ['with a wrong nonce', { nonce: 'guess' }],
    ['from another window', { source: other }],
  ])('ATTACK: a hello %s is ignored and receives nothing', async (_name, over) => {
    const { channel, hello, connects } = setup()
    const page = hello(over)
    const toPage: unknown[] = []
    page.onmessage = (e) => toPage.push(e.data)
    channel.send({ type: 'postplan:paint', anchors: [{ id: 't1', quote: 'secret' }] })
    await tick()
    expect(connects()).toBe(0)
    expect(toPage).toEqual([])
  })

  test('a new page replaces the old port; the old page hears nothing more', async () => {
    const { channel, hello } = setup()
    const first = hello()
    const firstGot: unknown[] = []
    first.onmessage = (e) => firstGot.push(e.data)
    hello()
    channel.send({ type: 'postplan:mode', mode: 'comment' })
    await tick()
    expect(firstGot).toEqual([])
  })
})
