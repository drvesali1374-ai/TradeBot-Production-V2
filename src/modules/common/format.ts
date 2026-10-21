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
