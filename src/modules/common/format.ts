'use client'

/**
 * Formatting helpers — Persian-friendly, LTR-numeric displays.
 *
 * Date/time (mission §4) — ONE central Jalali format everywhere in the UI:
 *     ۱۴۰۵/۰۷/۲۹, ۱۰:۰۵:۵۰
 *   (persian calendar · Asia/Tehran · Persian digits · seconds always present)
 * Server data stays UTC ISO (§4.2) — never reformatted server-side; conversion
 * happens ONLY here at render time. Persian-digit datetimes flow naturally in
 * RTL text (Extended Arabic-Indic digits are bidi class EN → the whole token
 * renders in logical order), so no bdi/.num isolation is required around THEM;
 * existing .num/bdi isolation for LATIN numerics is kept untouched.
 */

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function fmtPrice(n: number | null | undefined): string {
  return fmtNum(n, 2)
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '−' : ''
  // money amounts keep a stable 2-decimal presentation ($12.50, not $12.5)
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  })
  return `${sign}$${abs}`
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}${fmtNum(Math.abs(n), digits)}٪`
}

/**
 * Signed USDT amount WITHOUT the `$` prefix (mission §1.2 — PnL column
 * parentheses): `+12.30` / `−4.80` / `0.00` (no sign for exact zero —
 * same convention as fmtUsd/fmtPct); null/undefined/NaN → `'—'`.
 * The unit «USDT» is appended by the caller's JSX.
 * en-US Latin digits, thousands separators, exactly 2 fraction digits.
 */
export function fmtUsdtAmount(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${sign}${abs}`
}

/* ------------------------------------------------------------------ */
/* TP/SL tri-state display (mission §2.2 — never conflate)               */
/* ------------------------------------------------------------------ */

export type TpslLabelKind = 'price' | 'unset' | 'unknown'

export interface TpslLabel {
  /** ready-to-render text: formatted price, «تنظیم نشده» or «نامشخص» */
  text: string
  /**
   * 'price'   → real TP/SL price from a successful read-back (green/red)
   * 'unset'   → read-back OK + no order → genuinely «تنظیم نشده» (muted)
   * 'unknown' → read-back FAILED → «نامشخص» (warning-ish, distinct)
   */
  kind: TpslLabelKind
}

/**
 * Precision-preserving TP/SL price (item 8 — trailing zeros trimmed):
 * up to 8 significant decimals, NO minimum fraction digits, so Toobit's
 * raw precision survives without trailing-zero noise:
 *   0.1023     → `0.1023`   (never `0.10`)
 *   12.01032   → `12.01032`
 *   1.2        → `1.2`
 * null/undefined/NaN → `'—'`.
 */
export function fmtTpsl(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: 8, minimumFractionDigits: 0 })
}

/**
 * Tri-state TP/SL label (mission §2.2). The caller colors by `kind`:
 * price → long/short hue, unset → muted, unknown → warning-ish muted.
 *
 *  - status 'unknown'  → «نامشخص» ALWAYS (read-back failed; a stray value
 *    must not be trusted or conflated with "not set")
 *  - status 'ok'       → price when the stop order exists, else «تنظیم نشده»
 *  - status undefined/null (defensive, not in the live contract) → a value
 *    is shown when present, otherwise «نامشخص» — without a successful
 *    read-back we may NOT claim «تنظیم نشده».
 */
export function tpslLabel(value: number | null | undefined, status?: 'ok' | 'unknown' | null): TpslLabel {
  if (status === 'unknown') return { text: 'نامشخص', kind: 'unknown' }
  if (value != null && !Number.isNaN(value)) return { text: fmtTpsl(value), kind: 'price' }
  if (status === 'ok') return { text: 'تنظیم نشده', kind: 'unset' }
  return { text: 'نامشخص', kind: 'unknown' }
}

/* ------------------------------------------------------------------ */
/* Date/time — central Jalali formatting (mission §4)                     */
/* ------------------------------------------------------------------ */

/**
 * `fa-IR-u-nu-arabext` = fa-IR locale + arabext (Persian ۰-۹) numerals →
 * yields the persian calendar and Persian digits natively. Explicit
 * `timeZone: 'Asia/Tehran'` makes output independent of the viewer's clock.
 */
const jalaliDateTime = new Intl.DateTimeFormat('fa-IR-u-nu-arabext', {
  calendar: 'persian',
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const jalaliTime = new Intl.DateTimeFormat('fa-IR-u-nu-arabext', {
  calendar: 'persian',
  timeZone: 'Asia/Tehran',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Anything `new Date()` can digest, or nothing at all. */
export type DateTimeInput = string | number | Date | null | undefined

/** Strict validity gate — NEVER fabricate a date for bad input. */
function toValidDate(input: DateTimeInput): Date | null {
  if (input === null || input === undefined || input === '') return null
  const d = input instanceof Date ? input : new Date(input)
  return Number.isNaN(d.getTime()) ? null : d
}

/** formatToParts → `{ year, month, day, hour, minute, second }` map. */
function partsOf(fmt: Intl.DateTimeFormat, d: Date): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of fmt.formatToParts(d)) out[p.type] = p.value
  return out
}

/**
 * THE central Jalali datetime — `YYYY/MM/DD, HH:mm:ss` (Persian digits,
 * seconds always present): `۱۴۰۵/۰۷/۲۹, ۱۰:۰۵:۵۰`.
 * Invalid/null/undefined input → `'—'` (never "Invalid Date").
 */
export function fmtDateTime(input?: DateTimeInput): string {
  const d = toValidDate(input)
  if (!d) return '—'
  const p = partsOf(jalaliDateTime, d)
  return `${p.year}/${p.month}/${p.day}, ${p.hour}:${p.minute}:${p.second}`
}

/** Jalali time-of-day `HH:mm:ss` (Persian digits, Asia/Tehran, with seconds). */
export function fmtTime(input?: DateTimeInput): string {
  const d = toValidDate(input)
  if (!d) return '—'
  const p = partsOf(jalaliTime, d)
  return `${p.hour}:${p.minute}:${p.second}`
}

/** Relative «X دقیقه پیش» — kept for places where relative age is wanted; NOT a substitute for fmtDateTime. */
export function fmtAgo(input?: DateTimeInput): string {
  const d = toValidDate(input)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'چند لحظه پیش'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} دقیقه پیش`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ساعت پیش`
  return `${Math.floor(diff / 86_400_000)} روز پیش`
}

/**
 * Persian-digit execution duration (mission §3.1 summary header):
 *  - null/undefined/NaN → `'—'`
 *  - `< 1000` ms → `«۲۳۴ms»`
 *  - `≥ 1000` ms → `«۲.۳ ثانیه»` (one decimal, rounded half-away; ≥ 60s
 *    keeps growing in seconds — cycle durations are minutes at most)
 * Latin `ms` suffix pairs with Persian digits via the natural bidi of
 * Extended Arabic-Indic numerals (same rule as the Jalali datetime).
 */
export function fmtDurationFa(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${faDigits(Math.round(ms))}ms`
  const secs = ms / 1000
  const text = secs >= 100 ? Math.round(secs).toString() : secs.toFixed(1)
  return `${faDigits(text)} ثانیه`
}

/** Latin-digit string → Persian-digit string (0-9 → ۰-۹), other chars pass through. */
function faDigits(s: string | number): string {
  return String(s).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)])
}

export function fmtQty(n: number | null | undefined): string {
  return fmtNum(n, 0)
}

export function pnlColor(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'var(--text-muted)'
  return n > 0 ? 'var(--success)' : n < 0 ? 'var(--danger)' : 'var(--text-muted)'
}

export function shortSymbol(full: string): string {
  return full.replace(/-SWAP-USDT$/i, '')
}
