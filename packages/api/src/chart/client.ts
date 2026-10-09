import * as Plot from '@observablehq/plot'
import { type ChartData, deriveFreshness, parseChartData, parseCsv, relativeAge, toCsv, toRecords } from './model'

// Charts read pushed data through postplan.db or a site file through src.

type ChartsDb = {
  get: (id: string) => Promise<{ data?: unknown }>
  onCreate: (cb: (e: { id: string }) => void) => () => void
  onUpdate: (cb: (e: { id: string }) => void) => () => void
  onDelete: (cb: (e: { id: string }) => void) => () => void
  onReady: (cb: () => void) => () => void
}

const COLLECTION = 'shared-charts'
const SERIES_COLOR = 'rgba(37, 99, 235, 1)'
const MAX_TABLE_ROWS = 500
const FRESHNESS_COLOR = {
  fresh: 'rgba(22, 163, 74, 1)',
  aging: 'rgba(217, 119, 6, 1)',
  stale: 'rgba(220, 38, 38, 1)',
  unknown: 'rgba(148, 163, 184, 1)',
}

const style = document.createElement('style')
style.textContent =
  'pp-chart{display:block;margin:1rem 0;font:inherit}' +
  '.pp-chart{border:1px solid rgba(15,23,42,.12);border-radius:10px;padding:1rem;background:rgba(255,255,255,1);color:rgba(15,23,42,1)}' +
  '.pp-chart__title{margin:0 0 .75rem;font-size:1rem;font-weight:600}' +
  '.pp-chart__body{overflow-x:auto}.pp-chart__body svg{max-width:100%;height:auto}' +
  '.pp-chart__number{font-size:2.5rem;font-weight:700;line-height:1.1}' +
  '.pp-chart__table{border-collapse:collapse;font-size:.85rem;width:100%}' +
  '.pp-chart__table th,.pp-chart__table td{padding:.35rem .6rem;border-bottom:1px solid rgba(15,23,42,.08);text-align:left}' +
  '.pp-chart__table th{font-weight:600}.pp-chart__table .pp-chart__num{text-align:right;font-variant-numeric:tabular-nums}' +
  '.pp-chart__foot{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem .9rem;margin-top:.75rem;font-size:.75rem;color:rgba(71,85,105,1)}' +
  '.pp-chart__dot{display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.35rem}' +
  '.pp-chart__foot button,.pp-chart__foot summary{font:inherit;cursor:pointer;color:inherit;background:none;border:0;padding:0;text-decoration:underline}' +
  '.pp-chart__foot details{flex-basis:100%}.pp-chart__foot details[open]{order:9}' +
  '.pp-chart__sql{margin:.5rem 0 0;padding:.75rem;border-radius:6px;background:rgba(15,23,42,.05);white-space:pre-wrap;font:.75rem/1.5 ui-monospace,monospace}' +
  '.pp-chart__msg{font-size:.85rem;color:rgba(71,85,105,1)}.pp-chart__msg--error{color:rgba(185,28,28,1)}'
document.head.append(style)

function chartsDb(): ChartsDb | null {
  const db = (window as { postplan?: { db?: { collection: (n: string) => ChartsDb } } }).postplan?.db
  return db ? db.collection(COLLECTION) : null
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

type Encoding = { x: string; y: string; color?: string }

function marksFor(kind: string, records: Record<string, unknown>[], enc: Encoding): Plot.Markish[] {
  const { x, y, color } = enc
  const paint = color ?? SERIES_COLOR
  switch (kind) {
    case 'bar':
      return [Plot.barY(records, { x, y, fill: paint }), Plot.ruleY([0])]
    case 'area':
      return [Plot.areaY(records, { x, y, fill: paint, fillOpacity: 0.3 }), Plot.ruleY([0])]
    case 'dot':
      return [Plot.dot(records, { x, y, stroke: paint })]
    default:
      return [Plot.lineY(records, { x, y, stroke: paint })]
  }
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'number' ? v.toLocaleString() : String(v)
}

class PPChart extends HTMLElement {
  private data: ChartData | null = null
  private message = 'Loading…'
  private failed = false
  private cleanup: (() => void)[] = []
  private width = 0
  private loadVersion = 0

  connectedCallback() {
    this.render()
    this.load()
    const db = this.getAttribute('chart') && chartsDb()
    if (db) {
      const mine = (e: { id: string }) => e.id === this.getAttribute('chart') && this.load()
      this.cleanup.push(
        db.onUpdate(mine),
        db.onCreate(mine),
        db.onDelete(mine),
        db.onReady(() => this.load()),
      )
    }
    const tick = setInterval(() => this.data && this.render(), 60_000)
    this.cleanup.push(() => clearInterval(tick))
    const resize = new ResizeObserver(() => {
      if (Math.abs(this.clientWidth - this.width) > 8) this.render()
    })
    resize.observe(this)
    this.cleanup.push(() => resize.disconnect())
  }

  disconnectedCallback() {
    this.loadVersion++
    for (const off of this.cleanup.splice(0)) off()
  }

  private async load() {
    const version = ++this.loadVersion
    try {
      const result = await this.fetchData()
      if (version === this.loadVersion && this.isConnected) this.show(result)
    } catch (err) {
      if (version === this.loadVersion && this.isConnected) this.fail(err instanceof Error ? err.message : String(err))
    }
  }

  private async fetchData(): Promise<ChartData | string> {
    const src = this.getAttribute('src')
    if (src) {
      const res = await fetch(src)
      if (!res.ok) return `couldn't load ${src} (${res.status})`
      return parseChartData(/\.csv(\?|$)/i.test(src) ? parseCsv(await res.text()) : await res.json())
    }
    const id = this.getAttribute('chart')
    if (!id) return 'set chart="<id>" (from postplan data push) or src="data.json"'
    const db = chartsDb()
    if (!db) return 'postplan.db is not available on this page'
    try {
      return parseChartData((await db.get(id)).data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return /not found|404/i.test(msg) ? `no data yet: run postplan data push <site> ${id} <file>` : msg
    }
  }

  private show(result: ChartData | string) {
    if (typeof result === 'string') return this.fail(result)
    this.data = result
    this.failed = !!result.error
    this.message = result.error ?? ''
    this.render()
  }

  private fail(message: string) {
    this.data = null
    this.failed = true
    this.message = message
    this.render()
  }

  private render() {
    this.width = this.clientWidth
    const frame = el('figure', 'pp-chart')
    frame.style.margin = '0'
    const label = this.getAttribute('label')
    if (label) frame.append(el('figcaption', 'pp-chart__title', label))
    const body = el('div', 'pp-chart__body')
    if (this.data && !this.data.error) {
      try {
        body.append(this.draw(this.data))
      } catch (err) {
        body.append(el('p', 'pp-chart__msg pp-chart__msg--error', `can't draw: ${(err as Error).message}`))
      }
    }
    if (this.message) body.append(el('p', `pp-chart__msg${this.failed ? ' pp-chart__msg--error' : ''}`, this.message))
    frame.append(body)
    if (this.data) frame.append(this.footer(this.data))
    this.replaceChildren(frame)
  }

  private draw(data: ChartData): Element {
    const kind = this.getAttribute('kind') ?? 'line'
    const x = this.getAttribute('x') ?? data.columns[0]
    const y = this.getAttribute('y') ?? data.columns[1] ?? data.columns[0]
    const color = this.getAttribute('color') ?? undefined
    if (kind === 'table') return this.table(data)
    const records = toRecords(data)
    if (kind === 'number') {
      const last = records.at(-1)?.[y]
      return el('div', 'pp-chart__number', typeof last === 'number' ? last.toLocaleString() : String(last ?? '–'))
    }
    return Plot.plot({
      width: Math.max(240, this.clientWidth - 32),
      height: Number(this.getAttribute('height')) || 280,
      marginLeft: 56,
      y: { grid: true, label: y },
      x: { label: x },
      color: color ? { legend: true } : undefined,
      marks: marksFor(kind, records, { x, y, color }),
    })
  }

  private table(data: ChartData): Element {
    const table = el('table', 'pp-chart__table')
    const head = el('tr')
    const numeric = data.columns.map((_, i) => data.rows.some((r) => typeof r[i] === 'number'))
    data.columns.forEach((c, i) => {
      head.append(el('th', numeric[i] ? 'pp-chart__num' : undefined, c))
    })
    table.append(el('thead'), el('tbody'))
    table.tHead?.append(head)
    for (const row of data.rows.slice(0, MAX_TABLE_ROWS)) {
      const tr = el('tr')
      for (const v of row) {
        const td = el('td', typeof v === 'number' ? 'pp-chart__num' : undefined, cellText(v))
        tr.append(td)
      }
      table.tBodies[0].append(tr)
    }
    return table
  }

  private footer(data: ChartData): Element {
    const foot = el('div', 'pp-chart__foot')
    const now = Date.now()
    if (data.refreshedAt) {
      const fresh = el('span')
      const dot = el('span', 'pp-chart__dot')
      dot.style.background = FRESHNESS_COLOR[deriveFreshness(data, now)]
      fresh.append(dot, `Updated ${relativeAge(data.refreshedAt, now)}`)
      fresh.title = new Date(data.refreshedAt).toLocaleString()
      foot.append(fresh)
    }
    if (data.source) foot.append(el('span', undefined, data.source))
    foot.append(el('span', undefined, `${data.rows.length.toLocaleString()} rows`))
    const csv = el('button', undefined, 'CSV')
    csv.type = 'button'
    csv.addEventListener('click', () => this.download(data))
    foot.append(csv)
    if (data.sql) {
      const details = el('details')
      details.append(el('summary', undefined, 'SQL'), el('pre', 'pp-chart__sql', data.sql))
      foot.append(details)
    }
    return foot
  }

  private download(data: ChartData) {
    const url = URL.createObjectURL(new Blob([toCsv(data)], { type: 'text/csv' }))
    const a = el('a')
    a.href = url
    a.download = `${this.getAttribute('chart') ?? 'chart'}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

if (!customElements.get('pp-chart')) customElements.define('pp-chart', PPChart)
