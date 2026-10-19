/**
 * Daily levels — previous Tehran-day high / low / close per candle.
 *
 * Preserved behavior from the reference: "previous day" = previous day
 * PRESENT IN DATA (gap days skipped); lastClose of the current day
 * includes the forming candle for the level of *today* (used only for
 * display), while signals always evaluate against the previous day.
 */
import type { Candle } from '../types'
import type { DailyLevelRow } from '../types'
import { tehranDayKey } from '../time/tehran-day'

export interface DailyLevelsResult {
  rows: DailyLevelRow[]
  /** Tehran day start timestamps per candle (UI display) */
  dayStarts: number[]
}

export function computeDailyLevels(candles: Candle[]): DailyLevelsResult {
  const n = candles.length
  const rows: DailyLevelRow[] = new Array(n)
  const dayStarts: number[] = new Array(n)

  if (n === 0) return { rows, dayStarts }

  // Bucket by Tehran day
  const dayMap = new Map<number, { high: number; low: number; lastClose: number; lastTs: number }>()
  const candleDayKeys: number[] = new Array(n)

  for (let i = 0; i < n; i++) {
    const key = tehranDayKey(candles[i].openTime)
    candleDayKeys[i] = key
    let day = dayMap.get(key)
    if (!day) {
      day = { high: candles[i].high, low: candles[i].low, lastClose: candles[i].close, lastTs: candles[i].openTime }
      dayMap.set(key, day)
    } else {
      day.high = Math.max(day.high, candles[i].high)
      day.low = Math.min(day.low, candles[i].low)
      if (candles[i].openTime >= day.lastTs) {
        day.lastClose = candles[i].close
        day.lastTs = candles[i].openTime
      }
    }
  }

  const sortedDays = [...dayMap.keys()].sort((a, b) => a - b)

  for (let i = 0; i < n; i++) {
    const key = candleDayKeys[i]
    const idx = sortedDays.indexOf(key)
    const prevKey = idx > 0 ? sortedDays[idx - 1] : null
    const prev = prevKey != null ? dayMap.get(prevKey)! : null
    rows[i] = {
      prevDayHigh: prev ? prev.high : null,
      prevDayLow: prev ? prev.low : null,
      prevDayClose: prev ? prev.lastClose : null,
    }
    dayStarts[i] = key * 86_400_000 - 3.5 * 3600 * 1000
  }

  return { rows, dayStarts }
}
