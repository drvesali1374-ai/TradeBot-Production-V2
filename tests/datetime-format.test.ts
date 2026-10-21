/**
 * Central Jalali datetime format tests (mission §4):
 *   fmtDateTime/fmtTime — persian calendar · Asia/Tehran · Persian digits ·
 *   `YYYY/MM/DD, HH:mm:ss` with seconds ALWAYS present, `'—'` for bad input.
 * Run: bun run tests/datetime-format.test.ts
 *
 * Expected values are HARD-CODED and were verified twice:
 *   a) Intl probe in this environment (bun ICU):
 *        new Date('2026-10-20T06:30:50Z') → year=۱۴۰۵ month=۰۷ day=۲۸ hour=۱۰ minute=۰۰ second=۵۰
 *   b) manual Jalali arithmetic: 1 Farvardin 1405 = 2026-03-21 (equinox
 *      2026-03-20 14:46 UTC = 18:16 Tehran → after solar noon, year starts next day).
 *      Oct 20 = day 214 of the Jalali year; months 1-6 hold 31×6=186 days →
 *      day 214 = 28 Mehr 1405 → 1405/07/28. Tehran = UTC+3:30 (no DST since 2022)
 *      → 06:30:50Z = 10:00:50 local, same civil day.  ⇒  `۱۴۰۵/۰۷/۲۸, ۱۰:۰۰:۵۰`
 */
import { fmtDateTime, fmtTime, fmtAgo } from '../src/modules/common/format'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) pass++
  else {
    fail++
    console.error(`✗ ${label}`)
  }
}

/** `YYYY/MM/DD, HH:mm:ss` — every digit Persian (U+06F0..U+06F9), exact separators. */
const JALALI_RE =
  /^[\u06F0-\u06F9]{4}\/[\u06F0-\u06F9]{2}\/[\u06F0-\u06F9]{2}, [\u06F0-\u06F9]{2}:[\u06F0-\u06F9]{2}:[\u06F0-\u06F9]{2}$/

/** `HH:mm:ss` — Persian digits, seconds present. */
const JALALI_TIME_RE = /^[\u06F0-\u06F9]{2}:[\u06F0-\u06F9]{2}:[\u06F0-\u06F9]{2}$/

// 0) LOUD environment gate: this suite is meaningless if bun's ICU does not
//    produce Persian (arabext) digits for fa-IR-u-nu-arabext. Fail explicitly,
//    never silently pass on a crippled ICU.
{
  const probe = fmtDateTime(new Date('2026-10-20T06:30:50Z'))
  const icuOk = JALALI_RE.test(probe)
  assert(icuOk, `ICU capability: fa-IR-u-nu-arabext must yield Persian digits + persian calendar (got: "${probe}")`)
  if (!icuOk) {
    console.error('✗ ABORT: Intl/ICU in this runtime lacks Persian-arabext support — install full-icu. Not a format.ts bug.')
    process.exit(1)
  }
}

// 1) Known timestamp — UTC 2026-10-20T06:30:50Z → Tehran (+3:30) 10:00:50 same day → ۱۴۰۵/۰۷/۲۸, ۱۰:۰۰:۵۰
{
  const out = fmtDateTime('2026-10-20T06:30:50Z')
  assert(out === '۱۴۰۵/۰۷/۲۸, ۱۰:۰۰:۵۰', `known timestamp → "۱۴۰۵/۰۷/۲۸, ۱۰:۰۰:۵۰" (got: "${out}")`)
}

// 2) Midnight crossing — 2026-10-20T21:00:00Z → Tehran 2026-10-21 00:30:00 → ۱۴۰۵/۰۷/۲۹, ۰۰:۳۰:۰۰
//    Also catches the classic `hour12:false → hourCycle h24` engine bug ("۲۴:۳۰" instead of "۰۰:۳۰").
{
  const out = fmtDateTime('2026-10-20T21:00:00Z')
  assert(out === '۱۴۰۵/۰۷/۲۹, ۰۰:۳۰:۰۰', `midnight rollover → "۱۴۰۵/۰۷/۲۹, ۰۰:۳۰:۰۰" (got: "${out}")`)
  assert(!out.includes('۲۴'), 'midnight hour must be ۰۰ (h23), never ۲۴ (h24 engine bug)')
}

// 3) Null / undefined / invalid input → '—' — NEVER a fabricated date, never "Invalid Date"
{
  const cases: unknown[] = [null, undefined, '', 'garbage', NaN, 'not-a-date']
  for (const c of cases) {
    const out = fmtDateTime(c as never)
    assert(out === '—', `invalid input ${JSON.stringify(c)} → '—' (got: "${out}")`)
  }
  assert(fmtTime(null) === '—', 'fmtTime(null) → —')
  assert(fmtTime('garbage') === '—', 'fmtTime("garbage") → —')
  assert(fmtAgo(null) === '—', 'fmtAgo(null) → —')
}

// 4) ISO string / epoch-ms number / Date object → identical output
{
  const iso = fmtDateTime('2026-10-20T06:30:50Z')
  const ms = fmtDateTime(new Date('2026-10-20T06:30:50Z').getTime())
  const date = fmtDateTime(new Date('2026-10-20T06:30:50Z'))
  assert(iso === ms && ms === date, `ISO / epoch-ms / Date all identical (iso="${iso}" ms="${ms}" date="${date}")`)
  assert(iso === '۱۴۰۵/۰۷/۲۸, ۱۰:۰۰:۵۰', 'agreed value is the hard-coded Jalali string')
}

// 5) Structure: Persian digits everywhere, `YYYY/MM/DD, HH:mm:ss`, seconds always present
{
  const samples = [
    fmtDateTime('2026-10-20T06:30:50Z'),
    fmtDateTime(Date.now()),
    fmtDateTime(0), // epoch 0 is a REAL instant — must format, not fabricate
  ]
  for (const s of samples) assert(JALALI_RE.test(s), `format shape + Persian digits (got: "${s}")`)
}

// 6) fmtTime — time-only, Persian digits, Asia/Tehran, seconds included
{
  const t = fmtTime('2026-10-20T06:30:50Z')
  assert(t === '۱۰:۰۰:۵۰', `fmtTime Tehran +3:30 → "۱۰:۰۰:۵۰" (got: "${t}")`)
  assert(JALALI_TIME_RE.test(fmtTime('2026-10-20T21:00:00Z')), 'fmtTime midnight "۰۰:۳۰:۰۰" shape')
  const now = fmtTime(Date.now())
  assert(now.split(':').length === 3, `fmtTime always has seconds (got: "${now}")`)
}

// 7) fmtAgo — still works for explicit relative-age contexts only
//    (digits stay Latin digits — unchanged legacy behavior, out of §4 scope;
//     fmtAgo currently has ZERO call sites after the symbols-table switch)
{
  assert(fmtAgo(Date.now() - 5_000) === 'چند لحظه پیش', 'fmtAgo seconds → چند لحظه پیش')
  assert(fmtAgo(Date.now() - 120_000) === '2 دقیقه پیش', 'fmtAgo 2min → "2 دقیقه پیش" (legacy Latin digit)')
}

console.log(`datetime-format: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
