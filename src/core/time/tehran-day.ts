/**
 * Tehran day boundaries.
 *
 * The reference strategy computes "previous day" levels with a fixed
 * UTC+3:30 offset (Iran Standard Time, no DST handling — documented
 * assumption). Day key = floor((ts + 3.5h) / 24h).
 */
export const TEHRAN_OFFSET_MS = 3.5 * 3600 * 1000

export function tehranDayKey(ts: number): number {
  return Math.floor((ts + TEHRAN_OFFSET_MS) / 86_400_000)
}

/** Tehran-midnight timestamp of the day containing `ts`. */
export function tehranDayStart(ts: number): number {
  return tehranDayKey(ts) * 86_400_000 - TEHRAN_OFFSET_MS
}
