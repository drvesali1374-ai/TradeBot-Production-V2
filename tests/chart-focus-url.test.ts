/**
 * Chart-focus URL contract tests (mission §7.1/§7.3) — pure helpers, no DOM.
 *   buildChartFocusSearch / parseChartFocusSearch / stripChartFocusKeys
 * Run: bun run tests/chart-focus-url.test.ts
 */
import {
  buildChartFocusSearch,
  parseChartFocusSearch,
  stripChartFocusKeys,
  MIN_FOCUS_MS,
} from '../src/modules/chart/focusUrl'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) pass++
  else {
    fail++
    console.error(`✗ ${label}`)
  }
}

const FX = {
  symbol: 'BTC',
  interval: '1h',
  signalTime: 1_791_669_600_000,
  side: 'Long' as const,
}

// 1) build → exact documented shape, deterministic key order
{
  const out = buildChartFocusSearch(FX)
  assert(out === '?chart=BTC&interval=1h&focus=1791669600000&side=Long', `build exact shape (got: "${out}")`)
}
{
  const out = buildChartFocusSearch({ symbol: 'DOT', interval: '4h', signalTime: 1234567890123 })
  assert(out === '?chart=DOT&interval=4h&focus=1234567890123', `build without side omits the key (got: "${out}")`)
}

// 2) round-trip: build → parse restores every field
{
  const back = parseChartFocusSearch(buildChartFocusSearch(FX))
  assert(back != null, 'round-trip parses')
  assert(back?.symbol === 'BTC' && back?.interval === '1h' && back?.signalTime === FX.signalTime && back?.side === 'Long', 'round-trip fields intact')
}

// 3) parse accepts both '?x' and 'x' forms + trims/cases symbol
{
  const a = parseChartFocusSearch('?chart=btc&interval=15m&focus=1791669600000')
  const b = parseChartFocusSearch('chart=BTC&interval=15m&focus=1791669600000')
  assert(a?.symbol === 'BTC' && a?.interval === '15m', 'lowercase symbol normalized + leading ? accepted')
  assert(b?.signalTime === 1791669600000, 'bare search (no leading ?) accepted')
  assert(a?.side === undefined, 'absent side → undefined (not empty string)')
}

// 4) parse rejects invalid REQUIRED parts
{
  assert(parseChartFocusSearch('?interval=1h&focus=1791669600000') === null, 'missing symbol → null')
  assert(parseChartFocusSearch('?chart=&interval=1h&focus=1791669600000') === null, 'empty symbol → null')
  assert(parseChartFocusSearch('?chart=BT&interval=9h&focus=1791669600000') === null, 'unknown interval (9h not a toolbar tab) → null')
  assert(parseChartFocusSearch('?chart=BTC&interval=1h') === null, 'missing focus → null')
  assert(parseChartFocusSearch('?chart=BTC&interval=1h&focus=abc') === null, 'non-numeric focus → null')
  assert(parseChartFocusSearch('?chart=BTC&interval=1h&focus=1791669600000.5') === null, 'fractional focus → null')
  assert(parseChartFocusSearch('?chart=BTC&interval=1h&focus=-1791669600000') === null, 'negative focus → null')
  // unit guard: seconds instead of ms must be rejected, never silently centered
  assert(parseChartFocusSearch('?chart=BTC&interval=1h&focus=1791669600') === null, 'SECONDS-scale value rejected (ms contract)')
  assert(MIN_FOCUS_MS === 1_000_000_000_000, 'MIN_FOCUS_MS = 1e12 (2001-09-09 ms)')
}

// 5) invalid optional side is DROPPED, focus still parses
{
  const r = parseChartFocusSearch('?chart=BTC&interval=1h&focus=1791669600000&side=BUY')
  assert(r != null && r.side === undefined, 'bad side dropped, focus intact')
  const r2 = parseChartFocusSearch('?chart=BTC&interval=1h&focus=1791669600000&side=Short')
  assert(r2?.side === 'Short', 'side=Short parsed')
}

// 6) strip removes ONLY the four contract keys, keeps others
{
  const out = stripChartFocusKeys('?chart=BTC&interval=1h&focus=1791669600000&side=Long')
  assert(out === '', 'strip with only focus keys → empty string')
  const out2 = stripChartFocusKeys('?chart=BTC&interval=1h&focus=1&side=Short&foo=1&bar=2')
  assert(out2 === '?foo=1&bar=2', `strip preserves foreign params (got: "${out2}")`)
  const out3 = stripChartFocusKeys('?foo=1')
  assert(out3 === '?foo=1', 'untouched search passes through unchanged')
}

console.log(`chart-focus-url: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
