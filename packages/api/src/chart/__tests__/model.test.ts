import { describe, expect, test } from 'bun:test'
import { deriveFreshness, parseChartData, parseCsv, relativeAge, toCsv, toRecords } from '../model'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const ago = (sec: number) => new Date(NOW - sec * 1000).toISOString()

describe('deriveFreshness', () => {
  test.each([
    [ago(60), 3600, 'fresh'],
    [ago(3600), 3600, 'fresh'],
    [ago(3601), 3600, 'aging'],
    [ago(7200), 3600, 'aging'],
    [ago(7201), 3600, 'stale'],
    [ago(23 * 3600), undefined, 'fresh'],
    [ago(25 * 3600), 0, 'aging'],
    [undefined, 3600, 'unknown'],
    ['not a date', 3600, 'unknown'],
  ] as const)('refreshed %s with staleAfter %s → %s', (refreshedAt, staleAfter, want) => {
    expect(deriveFreshness({ refreshedAt, staleAfter }, NOW)).toBe(want)
  })
})

test('relativeAge rounds to the largest unit', () => {
  expect(relativeAge(ago(5), NOW)).toBe('just now')
  expect(relativeAge(ago(125), NOW)).toBe('2m ago')
  expect(relativeAge(ago(3 * 3600 + 5), NOW)).toBe('3h ago')
  expect(relativeAge(ago(50 * 3600), NOW)).toBe('2d ago')
  expect(relativeAge(undefined, NOW)).toBe('never')
})

describe('parseChartData', () => {
  test('bounds sparse expansion before allocating dense rows', () => {
    expect(parseChartData(Array.from({ length: 200 }, (_, i) => ({ [`c${i}`]: i })))).toContain('20,000 cells')
    expect(parseChartData({ columns: ['a', 'b'], rows: [[1]] })).toContain('column count')
  })
  test('a pushed doc keeps its provenance and drops wrongly typed fields', () => {
    const doc = parseChartData({ columns: ['a'], rows: [[1]], sql: 'select 1', source: 7, staleAfter: '1h' })
    expect(doc).toEqual({
      columns: ['a'],
      rows: [[1]],
      sql: 'select 1',
      source: undefined,
      refreshedAt: undefined,
      staleAfter: undefined,
      error: undefined,
    })
  })

  test('an array of objects becomes columns in first-seen order, gaps as null', () => {
    expect(
      parseChartData([
        { b: 1, a: 'x' },
        { a: 'y', c: true },
      ]),
    ).toEqual({
      columns: ['b', 'a', 'c'],
      rows: [
        [1, 'x', null],
        [null, 'y', true],
      ],
    })
  })

  test.each([null, 'x', { columns: 'a', rows: [] }, { columns: ['a'], rows: [1] }, [1, 2]])('rejects %p', (bad) => {
    expect(typeof parseChartData(bad)).toBe('string')
  })
})

test('toRecords turns ISO dates into Dates and leaves other values alone', () => {
  const [rec] = toRecords({ columns: ['week', 'n', 'label'], rows: [['2026-01-05', 3, 'Jan 5']] })
  expect(rec.week).toBeInstanceOf(Date)
  expect(rec.n).toBe(3)
  expect(rec.label).toBe('Jan 5')
})

test('CSV round-trips, quoting what needs it', () => {
  const data = {
    columns: ['name', 'n'],
    rows: [
      ['a, "b"', 1],
      ['line\nbreak', null],
    ],
  }
  const csv = toCsv(data)
  expect(csv).toBe('name,n\n"a, ""b""",1\n"line\nbreak",')
  expect(parseCsv(csv)).toEqual(data)
})

test('parseCsv reads CRLF files and numbers', () => {
  expect(parseCsv('x,y\r\n1,2.5\r\nb,\r\n')).toEqual({
    columns: ['x', 'y'],
    rows: [
      [1, 2.5],
      ['b', null],
    ],
  })
})
