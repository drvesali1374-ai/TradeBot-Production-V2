/**
 * Explicit closed-candle detection.
 *
 * REGRESSION FIX: the reference dropped the last (forming) candle with a
 * bare `i < N − 1` loop bound. Here closedness is checked explicitly:
 * a candle is closed when its close time has passed. The forming candle
 * is still useful for "last price" but never generates signals.
 */
import type { Candle } from '../types'

export function isCandleClosed(candle: Candle, now = Date.now()): boolean {
  return candle.closeTime <= now
}

/** Split candles into [closed, forming] — forming may be absent. */
export function splitClosedCandles(
  candles: Candle[],
  now = Date.now()
): { closed: Candle[]; forming: Candle | null } {
  const closed: Candle[] = []
  let forming: Candle | null = null
  for (const c of candles) {
    if (isCandleClosed(c, now)) closed.push(c)
    else if (!forming || c.openTime > forming.openTime) forming = c
  }
  return { closed, forming }
}

/** Interval string → milliseconds (Toobit intervals). */
export function intervalToMs(interval: string): number {
  const table: Record<string, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
  }
  return table[interval] ?? 3_600_000
}
