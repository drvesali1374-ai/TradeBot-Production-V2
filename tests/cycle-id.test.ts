/**
 * Cycle ID format tests (mission 4, item 5) — the owner's
 * {SYMBOL}_{YYYYMMDD}_{HHMMSS} format in the Jalali calendar,
 * Asia/Tehran timezone, ASCII digits. Run: bun run tests/cycle-id.test.ts
 */
import { makeCycleId } from '../src/server/automation/cycle-id'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`✗ ${label}`)
  }
}

const FORMAT = /^([A-Z0-9]+)_\d{8}_\d{6}$/

/* ---------------- format + sanitization ---------------- */

{
  const id = makeCycleId('DOT', Date.parse('2026-10-22T07:01:26Z'))
  assert(FORMAT.test(id), `format matches ${FORMAT} (got ${id})`)
  assert(!/[\u06F0-\u06F9\u0660-\u0669]/.test(id), 'ASCII digits only (no Persian/Arabic-Indic digits)')

  assert(FORMAT.test(makeCycleId('BTC', Date.now())), 'BTC → valid format')
  assert(FORMAT.test(makeCycleId('1000PEPE', Date.now())), 'numeric-leading symbol kept (1000PEPE)')
  assert(makeCycleId('dot', Date.parse('2026-10-22T07:01:26Z')) === makeCycleId('DOT', Date.parse('2026-10-22T07:01:26Z')), 'lowercase symbol → uppercased (dot == DOT)')

  const dirty = makeCycleId('do t-!', Date.parse('2026-10-22T07:01:26Z'))
  assert(dirty.startsWith('DOT_'), `dirty symbol sanitized to DOT prefix (got ${dirty})`)

  const symbols = ['dot', 'DoT', 'do t!', 'D-O-T']
  const ids = new Set(symbols.map((s) => makeCycleId(s, Date.parse('2026-10-22T07:01:26Z'))))
  assert(ids.size === 1, `all dirty/case variants collapse to the same prefix (${[...ids].join(', ')})`)

  // null / undefined / empty / non-alphanumeric-only → CYCLE prefix
  assert(makeCycleId(null, Date.parse('2026-10-22T07:01:26Z')).startsWith('CYCLE_'), 'null symbol → CYCLE_ prefix')
  assert(makeCycleId(undefined, Date.parse('2026-10-22T07:01:26Z')).startsWith('CYCLE_'), 'undefined symbol → CYCLE_ prefix')
  assert(makeCycleId('', Date.parse('2026-10-22T07:01:26Z')).startsWith('CYCLE_'), 'empty symbol → CYCLE_ prefix')
  assert(makeCycleId('###', Date.parse('2026-10-22T07:01:26Z')).startsWith('CYCLE_'), 'symbol with no [A-Z0-9] chars → CYCLE_ prefix')
  assert(FORMAT.test(makeCycleId(null, Date.parse('2026-10-22T07:01:26Z'))), 'CYCLE_-prefixed id still matches the format regex')
}

/* ---------------- Jalali correctness — hard-coded expectations ---------------- */

{
  // 2026-10-22T07:01:26Z = 1405/07/30 10:31:26 Asia/Tehran (UTC+3:30).
  // Verified by hand AND by an Intl probe: 1 Farvardin 1405 = 2026-03-21,
  // so 2026-10-22 is day 214+ → 30 Mehr 1405. This is the owner's example
  // id: DOT_14050730_103126.
  assert(makeCycleId('DOT', Date.parse('2026-10-22T07:01:26Z')) === 'DOT_14050730_103126', '2026-10-22T07:01:26Z → DOT_14050730_103126 (owner example)')

  // Nowruz: 2026-03-20T20:31:00Z = 1405/01/01 00:01:00 Tehran (year rollover)
  assert(makeCycleId('BTC', Date.parse('2026-03-20T20:31:00Z')) === 'BTC_14050101_000100', 'Nowruz 1405 rollover → BTC_14050101_000100')

  // Tehran midnight: 2026-10-22T20:30:00Z = 1405/08/01 00:00:00 — hour must
  // be 00 (h23), never 24, and the date must roll to the NEXT Jalali day.
  assert(makeCycleId('ETH', Date.parse('2026-10-22T20:30:00Z')) === 'ETH_14050801_000000', 'Tehran midnight → ETH_14050801_000000 (h24 bug guard)')

  // The timestamp from the spec note: 10:31:26Z is 14:01:26 Tehran same day
  // (2026-10-21 = 1405/07/29) — proves we use Tehran time, not UTC.
  assert(makeCycleId('DOT', Date.parse('2026-10-21T10:31:26Z')) === 'DOT_14050729_140126', '2026-10-21T10:31:26Z → DOT_14050729_140126 (UTC+3:30 applied)')
}

/* ---------------- Jalali correctness — Intl-generated expectations ---------------- */

{
  // Independent construction: numeric (unpadded) fields via a DIFFERENT
  // formatter configuration, then manual padding — cross-checks the field
  // extraction and 2-digit padding of makeCycleId without reusing its code.
  const numeric = new Intl.DateTimeFormat('en-US-u-ca-persian', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  })
  const expectedParts = (ms: number, symbol: string): string => {
    const fields: Record<string, string> = {}
    for (const p of numeric.formatToParts(new Date(ms))) {
      if (p.type !== 'literal' && p.type !== 'era') fields[p.type] = p.value
    }
    const p2 = (v: string, len: number) => v.padStart(len, '0')
    let hour = fields.hour ?? '0'
    if (hour === '24') hour = '0'
    return `${symbol}_${p2(fields.year, 4)}${p2(fields.month, 2)}${p2(fields.day, 2)}_${p2(hour, 2)}${p2(fields.minute, 2)}${p2(fields.second, 2)}`
  }

  const cases: [string, number][] = [
    ['DOT', Date.parse('2026-10-22T07:01:26Z')],
    ['XRP', Date.parse('2025-03-21T03:07:09Z')],
    ['TON', Date.parse('2024-06-15T16:45:30Z')],
    ['APT', Date.parse('2027-01-01T00:00:00Z')],
    ['ARB', Date.now()],
    ['CYCLE', Date.now() - 123_456],
  ]
  for (const [sym, ms] of cases) {
    const got = makeCycleId(sym, ms)
    const expected = expectedParts(ms, sym)
    assert(got === expected, `Intl cross-check ${sym} @${ms} → ${expected} (got ${got})`)
    assert(FORMAT.test(got), `Intl cross-check ${sym} @${ms} matches format regex`)
  }
}

/* ---------------- determinism ---------------- */

{
  const t = Date.parse('2026-10-22T07:01:26Z')
  assert(makeCycleId('DOT', t) === makeCycleId('DOT', t), 'same inputs → identical id (same-second determinism)')
  assert(makeCycleId(null, t) === makeCycleId(null, t), 'same inputs (null symbol) → identical id')
  // different symbols at the same instant differ ONLY in the prefix
  const a = makeCycleId('DOT', t)
  const b = makeCycleId('BTC', t)
  assert(a !== b && a.endsWith(b.slice(b.indexOf('_'))), 'different symbols at the same instant share the datetime suffix')
}

console.log(`cycle-id: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
