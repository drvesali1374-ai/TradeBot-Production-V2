/**
 * Chart-focus URL contract (mission §7.1 + §7.3) — PURE helpers, no DOM:
 *
 *   ?chart=<SYMBOL>&interval=<INTERVAL>&focus=<ms>[&side=Long|Short]
 *
 * UNITS (critical): `focus` is the signal's candleOpenTime in EPOCH
 * MILLISECONDS — the same unit Toobit kline rows and Signal.candleOpenTime
 * use. lightweight-charts works in SECONDS, but the URL never stores
 * seconds; ChartView converts ms→s only at chart-API boundaries.
 *
 * Restorability: page.tsx writes this URL via history.replaceState on every
 * «نمایش در چارت حرفه‌ای» navigation; on mount it parses the params back
 * into symbol/interval/focus so a refresh lands on the same signal candle.
 * price/tp/sl are deliberately NOT part of the URL (minimal + parseable):
 * after refresh the centering + marker still work from signalTime; the
 * Entry/TP/SL price lines only draw while the in-memory payload has them.
 */

import { INTERVALS } from './types'

export interface ChartFocusUrl {
  /** short symbol, e.g. 'BTC' (A-Z0-9, 2..16 — mirrors the chart symbol rule) */
  symbol: string
  /** chart interval — must be one of the toolbar tabs (INTERVALS) */
  interval: string
  /** signal candleOpenTime in EPOCH MILLISECONDS */
  signalTime: number
  /** optional trade direction decorator */
  side?: 'Long' | 'Short'
}

/** The four query keys owned by this contract. */
export const CHART_FOCUS_KEYS = ['chart', 'interval', 'focus', 'side'] as const

const SYMBOL_RE = /^[A-Z0-9]{2,16}$/

/**
 * Epoch-ms sanity floor: 2001-09-09T01:46:40Z (1e12 ms). A value below this
 * cannot be a valid ms-epoch candle time and almost certainly means someone
 * passed SECONDS — reject loudly instead of silently centering the chart
 * at the wrong bar (mission §7.2 «never the current time or live price»).
 */
export const MIN_FOCUS_MS = 1_000_000_000_000

/** Serialize a focus into `?chart=…&interval=…&focus=…[&side=…]`. */
export function buildChartFocusSearch(f: ChartFocusUrl): string {
  const q = new URLSearchParams()
  q.set('chart', f.symbol)
  q.set('interval', f.interval)
  q.set('focus', String(f.signalTime))
  if (f.side === 'Long' || f.side === 'Short') q.set('side', f.side)
  return `?${q.toString()}`
}

/**
 * Parse a search string ('?chart=BTC&interval=1h&focus=173…' or without the
 * leading '?') into a focus. Returns null when the REQUIRED keys are
 * missing/invalid; an invalid optional `side` is dropped, not fatal.
 */
export function parseChartFocusSearch(search: string): ChartFocusUrl | null {
  const q = new URLSearchParams(search)
  const symbol = (q.get('chart') ?? '').trim().toUpperCase()
  const interval = (q.get('interval') ?? '').trim()
  const focusRaw = q.get('focus')
  if (!SYMBOL_RE.test(symbol)) return null
  if (!(INTERVALS as readonly string[]).includes(interval)) return null
  if (focusRaw == null || focusRaw === '') return null
  const n = Number(focusRaw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_FOCUS_MS) return null
  const sideRaw = q.get('side')
  const side = sideRaw === 'Long' || sideRaw === 'Short' ? sideRaw : undefined
  return { symbol, interval, signalTime: n, ...(side ? { side } : {}) }
}

/**
 * Remove the focus keys from a search string, preserving every other
 * param. Returns '' when nothing remains, else a '?…' string — ready for
 * history.replaceState(pathname + result).
 */
export function stripChartFocusKeys(search: string): string {
  const q = new URLSearchParams(search)
  let touched = false
  for (const k of CHART_FOCUS_KEYS) {
    if (q.has(k)) {
      q.delete(k)
      touched = true
    }
  }
  if (!touched) return search.startsWith('?') ? search : search ? `?${search}` : ''
  const rest = q.toString()
  return rest ? `?${rest}` : ''
}
