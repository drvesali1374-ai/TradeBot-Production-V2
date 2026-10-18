/**
 * ATR — Wilder RMA, index-aligned.
 * Preserved quirk from the reference: seeded with the single first TR
 * (not the SMA of the first `period` TRs) — converges asymptotically.
 */
import type { Candle } from '../types'

export function calculateATR(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length
  const atr: (number | null)[] = new Array(n).fill(null)
  if (n === 0 || period < 1) return atr

  const tr: number[] = new Array(n)
  tr[0] = candles[0].high - candles[0].low
  for (let i = 1; i < n; i++) {
    const h = candles[i].high
    const l = candles[i].low
    const prevClose = candles[i - 1].close
    tr[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose))
  }

  atr[0] = tr[0]
  for (let i = 1; i < n; i++) {
    atr[i] = ((period - 1) * (atr[i - 1] as number) + tr[i]) / period
  }
  return atr
}
