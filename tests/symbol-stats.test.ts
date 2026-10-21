/**
 * Per-symbol closed-trade statistics tests (mission §8.1 acceptance):
 * winners/losers/breakeven mix, dedup of partial records, no-history
 * symbol, sort by closedTrades DESC with stable tie-breaks.
 * Run: bun run tests/symbol-stats.test.ts
 */
import { computeSymbolStats } from '../src/server/analytics/symbol-stats'
import type { ClosedPosition } from '../src/core/types'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) pass++
  else {
    fail++
    console.error(`✗ ${label}`)
  }
}

const pos = (over: Partial<ClosedPosition>): ClosedPosition => ({
  id: 'x',
  symbol: 'BTC-SWAP-USDT',
  side: 'LONG',
  qty: 10,
  closePrice: 100,
  closeTime: 1,
  realizedPnl: 0,
  realizedPnlRate: 0,
  leverage: 4,
  ...over,
})
;

// 1) Mixed fixture: BTC 2W/1L, ETH 1L/1B(even), SOL 3L → SOL first by count
{
  const res = computeSymbolStats(
    [
      pos({ id: 'a1', symbol: 'BTC-SWAP-USDT', realizedPnl: 2.5 }),
      pos({ id: 'a2', symbol: 'BTC-SWAP-USDT', realizedPnl: -1 }),
      pos({ id: 'a3', symbol: 'BTC-SWAP-USDT', realizedPnl: 0.75 }),
      pos({ id: 'b1', symbol: 'ETH-SWAP-USDT', realizedPnl: -0.5 }),
      pos({ id: 'b2', symbol: 'ETH-SWAP-USDT', realizedPnl: 0 }),
      pos({ id: 'c1', symbol: 'SOL-SWAP-USDT', realizedPnl: 0.1 }),
      pos({ id: 'c2', symbol: 'SOL-SWAP-USDT', realizedPnl: 0.2 }),
      pos({ id: 'c3', symbol: 'SOL-SWAP-USDT', realizedPnl: 0.3 }),
    ],
    { sourceLimit: 200 }
  )
  assert(res.stats.length === 3, '3 symbols')
  assert(res.stats[0].symbol === 'BTC', 'BTC first (tie 3 trades → higher netIncome wins)')
  assert(res.stats[0].closedTrades === 3, 'BTC count 3')
  assert(Math.abs(res.stats[0].winRate - 66.666) < 0.01, 'BTC winRate ≈ 66.67%')
  assert(Math.abs(res.stats[0].netIncome - 2.25) < 1e-9, 'BTC netIncome 2.25')
  assert(res.stats[1].symbol === 'SOL', 'SOL second (tie-break by netIncome)')
  assert(res.stats[1].winRate === 100, 'SOL winRate 100%')
  assert(Math.abs(res.stats[1].netIncome - 0.6) < 1e-9, 'SOL netIncome 0.6')
  assert(res.stats[2].symbol === 'ETH', 'ETH third (fewest closed trades)')
  const btc = res.stats.find((s) => s.symbol === 'BTC')!
  assert(btc.closedTrades === 3, 'BTC count 3')
  assert(btc.winningTrades === 2, 'BTC wins 2')
  assert(btc.losingTrades === 1, 'BTC losses 1')
  assert(Math.abs(btc.winRate - 66.666) < 0.01, 'BTC winRate ≈ 66.67%')
  assert(Math.abs(btc.netIncome - 2.25) < 1e-9, 'BTC netIncome 2.25')
  const eth = res.stats.find((s) => s.symbol === 'ETH')!
  assert(eth.breakevenTrades === 1, 'ETH breakeven 1')
  assert(eth.winRate === 0, 'ETH winRate 0% (loss + breakeven)')
  assert(res.truncated === false, 'not truncated under sourceLimit')
}

// 2) Dedup: partial records of the SAME trade id counted once (§8.1)
{
  const res = computeSymbolStats(
    [
      pos({ id: 'dup', symbol: 'BTC-SWAP-USDT', realizedPnl: 1 }),
      pos({ id: 'dup', symbol: 'BTC-SWAP-USDT', realizedPnl: 1 }),
    ],
    { sourceLimit: 200 }
  )
  assert(res.stats[0].closedTrades === 1, 'duplicate id counted once')
  assert(res.basedOnCount === 1, 'basedOnCount deduped')
}

// 3) Symbol without history simply absent — no fake zero rows
{
  const res = computeSymbolStats([pos({ id: 'z', symbol: 'BTC-SWAP-USDT' })], { sourceLimit: 200 })
  assert(!res.stats.some((s) => s.symbol === 'ETH'), 'no fake empty rows')
}

// 4) Sort: count DESC → netIncome DESC tie-break → symbol ASC
{
  const res = computeSymbolStats(
    [
      pos({ id: '1', symbol: 'AAA-SWAP-USDT', realizedPnl: 1 }),
      pos({ id: '2', symbol: 'BBB-SWAP-USDT', realizedPnl: 5 }),
      pos({ id: '3', symbol: 'CCC-SWAP-USDT', realizedPnl: 2 }),
    ],
    { sourceLimit: 200 }
  )
  assert(res.stats.map((s) => s.symbol).join(',') === 'BBB,CCC,AAA', 'tie on count → netIncome desc')
}

// 5) truncation flag when the source window is full (live cap 200)
{
  const many = Array.from({ length: 200 }, (_, i) => pos({ id: String(i), symbol: 'BTC-SWAP-USDT', realizedPnl: 0.1 }))
  const res = computeSymbolStats(many, { sourceLimit: 200 })
  assert(res.truncated === true, 'truncated=true at sourceLimit')
  assert(res.basedOnCount === 200, 'basedOnCount 200')
}

// 6) Empty history → empty stats (UI shows «داده‌ای موجود نیست», no zeros)
{
  const res = computeSymbolStats([], { sourceLimit: 200 })
  assert(res.stats.length === 0, 'empty history → empty stats')
}

console.log(`\nSymbol stats: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
