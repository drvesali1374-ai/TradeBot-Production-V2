/**
 * PnL mapping acceptance test (mission §1.2.7) — runs against SANITIZED
 * fixtures only (tests/fixtures/toobit-positions.sample.json), performs
 * NO network calls and NEVER sends orders.
 *
 * Run:  bun run tests/pnl-mapping.test.ts
 *
 * Verifies:
 *  - Long win / Long loss / Short win / Short loss / zero PnL
 *  - missing fields  → null (never fake zeros)
 *  - invalid values  → null
 *  - raw fraction profitRate (Toobit) → internal PERCENT contract (×100)
 *  - final display strings via fmtUsd/fmtPct (percent-units contract)
 */
import { normalizePosition } from '../src/server/exchanges/toobit/client'
import type { OpenPosition } from '../src/core/types'
import fixtures from './fixtures/toobit-positions.sample.json'
import { readFileSync } from 'fs'

// local copies of the UI formatters (client-side module is 'use client',
// so we inline the exact same logic for the display-contract assertions)
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}
function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '−' : ''
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits })
  return `${sign}$${abs}`
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}${fmtNum(Math.abs(n), digits)}٪`
}

type Expected = {
  unrealizedPnL: number | null
  profitRatePct: number | null
  entryPrice: number | null
  markPrice: number | null
  qty: number | null
  side: 'LONG' | 'SHORT'
  leverage?: number | null
}

let failures = 0
const cases = fixtures[0].cases as Array<{
  name: string
  raw: Record<string, unknown>
  expected: Expected
}>

const close = (a: number | null, b: number | null): boolean =>
  a === b || (a != null && b != null && Math.abs(a - b) < 0.001)

for (const c of cases) {
  const p: OpenPosition = normalizePosition(c.raw)
  const e = c.expected
  const checks: Array<[string, boolean]> = [
    ['side', p.side === e.side],
    ['qty', close(p.qty, e.qty)],
    ['entryPrice', close(p.entryPrice, e.entryPrice)],
    ['markPrice', close(p.markPrice, e.markPrice)],
    ['unrealizedPnL', close(p.unrealizedPnL, e.unrealizedPnL)],
    ['profitRate (fraction→percent ×100)', close(p.profitRate, e.profitRatePct)],
    ['takeProfit stays null (docs: not exposed)', p.takeProfit == null && p.stopLoss == null],
  ]
  if (e.leverage !== undefined) checks.push(['leverage', close(p.leverage, e.leverage)])

  const failed = checks.filter(([, ok]) => !ok)
  if (failed.length) {
    failures++
    console.error(`✗ ${c.name}: ${failed.map(([k]) => k).join(', ')} MISMATCH`)
    console.error(`  got: ${JSON.stringify(p)}`)
  } else {
    console.log(`✓ ${c.name}`)
  }
}

/* display contract — raw 0.003 fraction must render as 0.3٪, NOT 0.003٪ */
const disp = normalizePosition({ symbol: 'BTC-SWAP-USDT', side: 'LONG', avgPrice: '24000', position: '10', leverage: '2', margin: '11.9825', unrealizedPnL: '12.5', profitRate: '0.003', markPrice: '24125' })
const amountStr = fmtUsd(disp.unrealizedPnL)
const pctStr = fmtPct(disp.profitRate)
const missing = normalizePosition({ symbol: 'X-SWAP-USDT', side: 'SHORT', position: '5' })
console.log(`  display: raw profitRate "0.003" → model ${disp.profitRate} → "${pctStr}" ; amount → "${amountStr}"`)
console.log(`  display (missing fields): PnL "${fmtUsd(missing.unrealizedPnL)}" pct "${fmtPct(missing.profitRate)}" price "${fmtNum(missing.entryPrice)}"`)
if (pctStr !== '+0.3٪') { failures++; console.error(`✗ fraction→percent display contract FAILED: got "${pctStr}", expected "+0.3٪"`) } else console.log('✓ fraction→percent display contract (0.003 → +0.3٪)')
if (amountStr !== '$12.50') { failures++; console.error(`✗ PnL amount display FAILED: got "${amountStr}"`) } else console.log('✓ PnL amount display direct from exchange field ($12.50)')
if (fmtPct(missing.profitRate) !== '—') { failures++; console.error('✗ missing value must render «—» (نامشخص), not fake zero') } else console.log('✓ missing value renders «—» (نامشخص) — no fake zero')

/* Long/Short sign consistency */
const longLoss = normalizePosition({ symbol: 'A-SWAP-USDT', side: 'LONG', unrealizedPnL: '-2.35', profitRate: '-0.5874' })
const shortWin = normalizePosition({ symbol: 'B-SWAP-USDT', side: 'SHORT', unrealizedPnL: '3.05', profitRate: '0.5075' })
if (!longLoss.profitRate || longLoss.profitRate >= 0 || !longLoss.unrealizedPnL || longLoss.unrealizedPnL >= 0) { failures++; console.error('✗ Long-loss sign consistency FAILED') } else console.log('✓ Long-loss signs consistent (−$2.35 / −58.7٪)')
if (!shortWin.profitRate || shortWin.profitRate <= 0 || !shortWin.unrealizedPnL || shortWin.unrealizedPnL <= 0) { failures++; console.error('✗ Short-win sign consistency FAILED') } else console.log('✓ Short-win signs consistent')

console.log(failures === 0 ? '\nALL PNL MAPPING TESTS PASSED' : `\n${failures} TEST GROUP(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
