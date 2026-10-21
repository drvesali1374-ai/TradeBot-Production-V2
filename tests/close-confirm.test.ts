/**
 * Close-confirm UI contract tests (mission §1.2 + §2.2) — pure formatting
 * helpers used by the close dialog / positions table. NO network, NO real
 * orders, NO exchange credentials. Run: bun run tests/close-confirm.test.ts
 */
import { fmtUsdtAmount, tpslLabel, fmtPrice } from '../src/modules/common/format'

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

/* ---------------- fmtUsdtAmount (§1.2 — PnL parentheses) ---------------- */

{
  assert(fmtUsdtAmount(12.3) === '+12.30', 'positive → +12.30 (sign + exactly 2 decimals)')
  assert(fmtUsdtAmount(-4.8) === '−4.80', 'negative → −4.80 (U+2212 minus, 2 decimals)')
  assert(fmtUsdtAmount(-4.8).charCodeAt(0) === 0x2212, 'negative uses U+2212 MINUS SIGN, not ASCII hyphen')
  assert(fmtUsdtAmount(0) === '0.00', 'exact zero → 0.00 (no sign, same convention as fmtUsd/fmtPct)')
  assert(fmtUsdtAmount(0.001) === '+0.00', 'tiny positive rounds to +0.00 but keeps the + sign')
  assert(fmtUsdtAmount(null) === '—', 'null → —')
  assert(fmtUsdtAmount(undefined) === '—', 'undefined → —')
  assert(fmtUsdtAmount(Number.NaN) === '—', 'NaN → —')
  assert(fmtUsdtAmount(12345.678) === '+12,345.68', 'thousands separators + rounding to 2 decimals')
  assert(fmtUsdtAmount(-1234567.891) === '−1,234,567.89', 'large negative keeps separators')
}

/* ---------------- tpslLabel (§2.2 — tri-state, never conflated) ---------------- */

{
  // ok + value → real price
  const a = tpslLabel(1.1987, 'ok')
  assert(a.kind === 'price', 'ok+value → kind price')
  assert(a.text === fmtPrice(1.1987), 'ok+value → formatted price text (fmtPrice)')

  // ok + null → genuinely not set
  const b = tpslLabel(null, 'ok')
  assert(b.kind === 'unset', 'ok+null → kind unset')
  assert(b.text === 'تنظیم نشده', 'ok+null → «تنظیم نشده»')

  // unknown → «نامشخص» EVEN when a stray value is present (must not trust it)
  const c = tpslLabel(1.1987, 'unknown')
  assert(c.kind === 'unknown', 'unknown+stray value → kind unknown')
  assert(c.text === 'نامشخص', 'unknown+stray value → «نامشخص» (stray value NOT shown)')
  const d = tpslLabel(null, 'unknown')
  assert(d.kind === 'unknown' && d.text === 'نامشخص', 'unknown+null → «نامشخص»')

  // defensive (not in the live contract): status undefined
  const e = tpslLabel(1.465, undefined)
  assert(e.kind === 'price', 'undefined status + value → kind price')
  assert(e.text === fmtPrice(1.465), 'undefined status + value → price shown')
  const f = tpslLabel(null, undefined)
  assert(f.kind === 'unknown', 'undefined status + null → kind unknown')
  assert(f.text === 'نامشخص', 'undefined status + null → «نامشخص» (never claims «تنظیم نشده» without read-back)')

  // live probe fixture values (XRP-SHORT TP/SL) map cleanly
  const xrp = tpslLabel(1.1987, 'ok')
  assert(xrp.text === '1.2', 'XRP TP 1.1987 renders through fmtPrice (2-decimal display)')
}

console.log(`close-confirm: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
