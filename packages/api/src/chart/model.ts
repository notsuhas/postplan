// The data behind <pp-chart>: what `postplan data push` stores, read back as plain records.

export type ChartData = {
  columns: string[]
  rows: unknown[][]
  sql?: string
  source?: string
  refreshedAt?: string
  staleAfter?: number
  error?: string
}

export type Freshness = 'fresh' | 'aging' | 'stale' | 'unknown'

const DEFAULT_STALE_SEC = 24 * 60 * 60

/** Green until staleAfter, amber up to twice that, red after. */
export function deriveFreshness(data: Pick<ChartData, 'refreshedAt' | 'staleAfter'>, now: number): Freshness {
  const at = data.refreshedAt ? Date.parse(data.refreshedAt) : Number.NaN
  if (Number.isNaN(at)) return 'unknown'
  const limit = (data.staleAfter && data.staleAfter > 0 ? data.staleAfter : DEFAULT_STALE_SEC) * 1000
  const age = now - at
  if (age <= limit) return 'fresh'
  return age <= 2 * limit ? 'aging' : 'stale'
}

export function relativeAge(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN
  if (Number.isNaN(at)) return 'never'
  const sec = Math.max(0, Math.round((now - at) / 1000))
  if (sec < 60) return 'just now'
  const units: [number, string][] = [
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ]
  for (const [size, unit] of units) if (sec >= size) return `${Math.floor(sec / size)}${unit} ago`
  return 'just now'
}

/** A pushed doc, or a fetched JSON/CSV file, as validated chart data; a string says what's wrong. */
export function parseChartData(raw: unknown): ChartData | string {
  if (Array.isArray(raw)) return fromObjects(raw)
  if (!raw || typeof raw !== 'object') return 'chart data must be an object or an array of objects'
  const doc = raw as Record<string, unknown>
  if (!Array.isArray(doc.columns) || !doc.columns.every((c) => typeof c === 'string'))
    return 'chart data needs a "columns" array of names'
  if (!Array.isArray(doc.rows) || !doc.rows.every((r) => Array.isArray(r))) return 'chart data needs a "rows" array'
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return {
    columns: doc.columns,
    rows: doc.rows as unknown[][],
    sql: str(doc.sql),
    source: str(doc.source),
    refreshedAt: str(doc.refreshedAt),
    staleAfter: typeof doc.staleAfter === 'number' ? doc.staleAfter : undefined,
    error: str(doc.error),
  }
}

function fromObjects(items: unknown[]): ChartData | string {
  const columns: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return 'chart data must be an array of objects'
    for (const key of Object.keys(item)) if (!columns.includes(key)) columns.push(key)
  }
  const rows = items.map((item) => columns.map((c) => (item as Record<string, unknown>)[c] ?? null))
  return { columns, rows }
}

export function toRecords(data: ChartData): Record<string, unknown>[] {
  return data.rows.map((row) => Object.fromEntries(data.columns.map((c, i) => [c, toValue(row[i])])))
}

// ISO dates become Dates so Plot picks a time axis; everything else passes through.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/
function toValue(v: unknown): unknown {
  return typeof v === 'string' && ISO_DATE.test(v) ? new Date(v) : v
}

export function toCsv(data: ChartData): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [data.columns, ...data.rows].map((r) => r.map(cell).join(',')).join('\n')
}

export function parseCsv(text: string): ChartData {
  const records: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      records.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    records.push(row)
  }
  const [columns = [], ...rest] = records
  const num = (s: string) => (s === '' ? null : Number.isFinite(Number(s)) ? Number(s) : s)
  return { columns, rows: rest.map((r) => r.map(num)) }
}
