/**
 * Per-symbol closed-trade statistics (mission §8) — PURE aggregation over
 * the exchange's closed-position history. Server-side single computation
 * point; the UI only renders.
 *
 * Data source: GET /api/v1/futures/historyPositions — one aggregate call
 * for ALL symbols (no per-symbol requests). Live-verified rows already
 * carry the realized values; `id` is the position ID used for dedup.
 *
 * Definitions (documented for the UI):
 *  - closedTrades: deduped closed positions per symbol
 *  - winning/losing/breakeven: realizedPnL > 0 / < 0 / == 0
 *  - winRate: winning / closedTrades (percent)
 *  - netIncome: Σ realizedPnL — AFTER-FEE realized value (live-verified:
 *    realizedPnL ≈ realizedPnLWithoutFee − openFee − closeFee)
 *
 * Sort: closedTrades DESC, then netIncome DESC, then symbol ASC (stable
 * tie-break, mission §8.2).
 */
import type { ClosedPosition, SymbolStat } from '@/core/types'

export interface SymbolStatsResult {
  stats: SymbolStat[]
  /** How many closed records the computation is based on. */
  basedOnCount: number
  /** true = the source window is smaller than the account's full history. */
  truncated: boolean
}

export function computeSymbolStats(
  positions: ClosedPosition[],
  options: { sourceLimit: number }
): SymbolStatsResult {
  // Dedup by position id (one trade must not be counted twice — §8.1)
  const byId = new Map<string, ClosedPosition>()
  for (const p of positions) {
    if (!p.symbol) continue
    if (!byId.has(p.id)) byId.set(p.id, p)
  }

  const perSymbol = new Map<string, { closed: number; win: number; lose: number; even: number; income: number }>()
  for (const p of byId.values()) {
    const key = p.symbol.replace(/-SWAP-USDT$/, '')
    let agg = perSymbol.get(key)
    if (!agg) {
      agg = { closed: 0, win: 0, lose: 0, even: 0, income: 0 }
      perSymbol.set(key, agg)
    }
    agg.closed++
    const pnl = p.realizedPnl
    if (pnl > 0) agg.win++
    else if (pnl < 0) agg.lose++
    else agg.even++
    agg.income += pnl
  }

  const stats: SymbolStat[] = [...perSymbol.entries()].map(([symbol, agg]) => ({
    symbol,
    closedTrades: agg.closed,
    winningTrades: agg.win,
    losingTrades: agg.lose,
    breakevenTrades: agg.even,
    winRate: agg.closed ? (agg.win / agg.closed) * 100 : 0,
    netIncome: Math.round(agg.income * 1e6) / 1e6,
  }))

  stats.sort((a, b) => b.closedTrades - a.closedTrades || b.netIncome - a.netIncome || a.symbol.localeCompare(b.symbol))

  return {
    stats,
    basedOnCount: byId.size,
    truncated: byId.size >= options.sourceLimit,
  }
}
