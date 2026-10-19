/**
 * RSI — Wilder smoothing (RMA), index-aligned.
 *
 * REGRESSION FIX (documented): the reference implementation
 * (public/js/shared/signal-utils.js) pushed one value per loop iteration
 * (i = 1..N−1) producing an N−1 array where rsi[k] actually belonged to
 * candle k+1 — a 1-candle lookahead and live repainting. This module
 * returns a length-N array aligned with the input candles:
 * rsi[i] is the RSI of candle i, rsi[0..period] are null.
 *
 * Formula preserved verbatim otherwise (including the avgLoss=0 → rs=100
 * quirk so RSI tops out at ~99.01 instead of 100).
 */
import type { Candle } from '../types'

export function calculateRSI(candles: Candle[], period = 14): (number | null)[] {
  const n = candles.length
  const rsi: (number | null)[] = new Array(n).fill(null)
  if (n < period + 1 || period < 1) return rsi

  let avgGain = 0
  let avgLoss = 0

  // Seed: simple average of first `period` changes (candles 1..period)
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close
    avgGain += Math.max(change, 0)
    avgLoss += Math.max(-change, 0)
  }
  avgGain /= period
  avgLoss /= period
  // rsi[period] stays null in the reference (first value is one candle
  // after textbook Wilder) — preserved for behavioral compatibility.
  // Wilder smoothing for the rest, aligned: value pushed at index i.
  for (let i = period + 1; i < n; i++) {
    const change = candles[i].close - candles[i - 1].close
    const gain = Math.max(change, 0)
    const loss = Math.max(-change, 0)
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    rsi[i] = 100 - 100 / (1 + rs)
  }
  return rsi
}
