/**
 * Signal status resolution (history-based, single source).
 *
 * Reference behavior (audit-2 §A.8 / audit-1): a signal is OPENED when a
 * same-direction exchange fill exists at/after its confirmation; the
 * latest unmatched signal is PENDING (or EXPIRED past the expiration
 * window); older unmatched ones are NOT_OPENED.
 */
import type { Signal, SignalStatus } from '../types'

export interface HistoryFill {
  time: number
  side: 'LONG' | 'SHORT'
  symbol: string
}

export function resolveSignalStatus(
  signals: Signal[],
  fills: HistoryFill[],
  expirationHours: number,
  now = Date.now()
): Map<string, SignalStatus> {
  const statuses = new Map<string, SignalStatus>()
  for (const s of signals) statuses.set(s.id, 'NOT_OPENED')

  // Symbol forms differ across sources (Signal.symbol is short "BTC",
  // exchange fills carry "BTC-SWAP-USDT") — normalize before comparing.
  const short = (sym: string) => String(sym).toUpperCase().replace(/-SWAP-USDT$/, '')

  // Mark OPENED for signals followed by a same-direction fill within
  // [candleOpenTime, nextSignal's candleOpenTime) — REFERENCE FIDELITY
  // (mission §6): the reference signal `timestamp` is the candle OPEN
  // time, so a fill during the signal candle itself already counts as
  // OPENED for that signal (automation-manager.js:1120-1182).
  const sorted = [...signals].sort((a, b) => a.candleOpenTime - b.candleOpenTime)
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    const next = sorted[i + 1]
    const windowEnd = next ? next.candleOpenTime : Infinity
    const targetSide = s.side === 'Long' ? 'LONG' : 'SHORT'
    const matched = fills.some(
      (f) =>
        short(f.symbol) === short(s.symbol) &&
        f.side === targetSide &&
        f.time >= s.candleOpenTime &&
        f.time < windowEnd
    )
    if (matched) statuses.set(s.id, 'OPENED')
  }

  // Latest signal: PENDING or EXPIRED (age from the candle OPEN time —
  // reference signal.timestamp semantics, automation-manager.js:1189-1197)
  const latest = sorted[sorted.length - 1]
  if (latest && statuses.get(latest.id) !== 'OPENED') {
    const expired = now - latest.candleOpenTime > expirationHours * 3600_000
    statuses.set(latest.id, expired ? 'EXPIRED' : 'PENDING')
  }
  return statuses
}
