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

  // Mark OPENED for signals followed by a same-direction fill within
  // [signalConfirmedAt, nextSignalConfirmedAt)
  const sorted = [...signals].sort((a, b) => a.signalConfirmedAt - b.signalConfirmedAt)
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i]
    const next = sorted[i + 1]
    const windowEnd = next ? next.signalConfirmedAt : Infinity
    const targetSide = s.side === 'Long' ? 'LONG' : 'SHORT'
    const matched = fills.some(
      (f) =>
        f.symbol === s.symbol &&
        f.side === targetSide &&
        f.time >= s.signalConfirmedAt &&
        f.time < windowEnd
    )
    if (matched) statuses.set(s.id, 'OPENED')
  }

  // Latest signal: PENDING or EXPIRED
  const latest = sorted[sorted.length - 1]
  if (latest && statuses.get(latest.id) !== 'OPENED') {
    const expired = now - latest.signalConfirmedAt > expirationHours * 3600_000
    statuses.set(latest.id, expired ? 'EXPIRED' : 'PENDING')
  }
  return statuses
}
