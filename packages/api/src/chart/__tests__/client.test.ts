import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { createSubscriptions, type StreamHandlers } from '../../postplandb/subscriptions'

type IDeferred = { resolve: (value: unknown) => void; reject: (error: Error) => void }
type IEvent = { id: string }
type IChartsDb = {
  get: () => Promise<unknown>
  onCreate: (cb: (event: IEvent) => void) => () => void
  onUpdate: (cb: (event: IEvent) => void) => () => void
  onDelete: (cb: (event: IEvent) => void) => () => void
  onReady: (cb: () => void) => () => void
}

const win = new Window()
const pending: IDeferred[] = []
const callbacks = new Map<string, (event: IEvent) => void>()
let restore: () => void
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
const doc = (n: number) => ({ data: { columns: ['n'], rows: [[n]] } })

function useDb(db: IChartsDb) {
  Object.assign(win, { postplan: { db: { collection: () => db } } })
}

function chart() {
  const node = win.document.createElement('pp-chart')
  node.setAttribute('chart', 'revenue')
  node.setAttribute('kind', 'number')
  node.setAttribute('y', 'n')
  win.document.body.append(node)
  return node
}

beforeAll(async () => {
  const global = globalThis as unknown as Record<string, unknown>
  const names = ['window', 'document', 'HTMLElement', 'customElements', 'ResizeObserver']
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(global, name)] as const)
  for (const name of names) {
    Object.defineProperty(global, name, {
      value: name === 'window' ? win : (win as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(global, name, descriptor)
      else delete global[name]
    }
  }
  await import('../client')
})

beforeEach(() => {
  pending.length = 0
  callbacks.clear()
  const subscribe = (name: string, cb: (event: IEvent) => void) => {
    callbacks.set(name, cb)
    return () => callbacks.delete(name)
  }
  useDb({
    get: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    onCreate: (cb) => subscribe('create', cb),
    onUpdate: (cb) => subscribe('update', cb),
    onDelete: (cb) => subscribe('delete', cb),
    onReady: () => () => {},
  })
})

afterEach(() => win.document.body.replaceChildren())
afterAll(async () => {
  await win.happyDOM.abort()
  restore()
})

test('older reads cannot overwrite a newer refresh', async () => {
  const node = chart()
  callbacks.get('update')?.({ id: 'revenue' })
  pending[1].resolve(doc(2))
  await turn()
  pending[0].resolve(doc(1))
  await turn()
  expect(node.querySelector('.pp-chart__number')?.textContent).toBe('2')
})

test('deleted data clears the old chart and downloads', async () => {
  const node = chart()
  pending[0].resolve(doc(1))
  await turn()
  callbacks.get('delete')?.({ id: 'revenue' })
  pending[1].reject(new Error('not found'))
  await turn()
  expect(node.querySelector('.pp-chart__number')).toBeNull()
  expect(node.querySelector('button')).toBeNull()
  expect(node.textContent).toContain('no data yet')
})

test('initial subscription readiness refreshes a snapshot read before the stream opened', async () => {
  let stream: StreamHandlers | undefined
  let value = 1
  const subs = createSubscriptions({
    open: (handlers) => {
      stream = handlers
    },
    catchUp: async () => ({ events: [], cursor: 'current' }),
    close: () => {},
  })
  useDb({
    get: async () => doc(value),
    onCreate: (cb) => subs.on('shared-charts', 'create', cb),
    onUpdate: (cb) => subs.on('shared-charts', 'update', cb),
    onDelete: (cb) => subs.on('shared-charts', 'delete', cb),
    onReady: (cb) => subs.onReady(cb),
  })
  const node = chart()
  await turn()
  expect(node.querySelector('.pp-chart__number')?.textContent).toBe('1')
  value = 2
  stream?.onOpen()
  await turn()
  expect(node.querySelector('.pp-chart__number')?.textContent).toBe('2')
})

test.each([
  ['oversized', `n\n${'1\n'.repeat(20_001)}`, '20,000 cells'],
  ['ragged', 'n,total\n1\n', 'column count'],
] as const)('CSV src rejects %s data', async (_name, csv, error) => {
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
  let fetches = 0
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string) => {
      expect(input).toBe('data.csv')
      fetches++
      return new Response(csv, { headers: { 'content-type': 'text/csv' } })
    },
  })
  try {
    const node = win.document.createElement('pp-chart')
    node.setAttribute('src', 'data.csv')
    node.setAttribute('kind', 'number')
    node.setAttribute('y', 'n')
    win.document.body.append(node)
    await turn()
    expect(fetches).toBe(1)
    expect(pending).toHaveLength(0)
    expect(node.querySelector('.pp-chart__msg--error')?.textContent).toContain(error)
    expect(node.querySelector('.pp-chart__number')).toBeNull()
    expect(node.querySelector('button')).toBeNull()
  } finally {
    if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor)
    else Reflect.deleteProperty(globalThis, 'fetch')
  }
})
