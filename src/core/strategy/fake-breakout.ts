/**
 * Fake Breakout state machine + meaningful-break detection.
 *
 * Faithful port of the reference behavior (audit-2 §B.3–B.6):
 *  - Meaningful break: wick (or close, per setting) beyond the previous
 *    Tehran-day level by ≥ ATR × breakAtrMultiplier (per direction).
 *  - Lifecycle states: Idle → Break → (Waiting Recovery) → Recovery →
 *    Signal → Reset. Break expires after `lifetime` candles
 *    (breakSequenceLifetime || lookback). Opposite-direction break
 *    REPLACES a pending one; same-direction re-break is ignored.
 *    Recovery = close back inside the level. Same-candle break+recovery
 *    (single-candle fake-out) is possible. The break is consumed
 *    (reset) on the recovery candle regardless of whether a signal
 *    fires.
 *  - Legacy mode (lifecycle disabled): close crosses back inside the
 *    level while a break happened within `lookback` candles.
 */
import type { Candle } from '../types'
import type { DailyLevelRow } from '../types'
import type { AutomationSettings } from '../settings'

export type BreakType = 'Long' | 'Short'

export interface BreakState {
  active: boolean
  type: BreakType | null
  breakCandleIndex: number | null
  waitingRecovery: boolean
  recovered: boolean
  recoveryCandleIndex: number | null
}

export function resetBreakState(): BreakState {
  return { active: false, type: null, breakCandleIndex: null, waitingRecovery: false, recovered: false, recoveryCandleIndex: null }
}

/** Recovery candidates produced by the state machine. */
export interface RecoveryEvent {
  index: number
  type: BreakType
}

/**
 * Runs the break lifecycle over CLOSED candles (candle 0 excluded to
 * mirror the reference loop `i = 1..N−2` on the closed window).
 * Returns recovery events; entry filters are applied by the caller.
 */
export function runBreakLifecycle(
  candles: Candle[],
  levels: DailyLevelRow[],
  atr: (number | null)[],
  settings: AutomationSettings,
  now = Date.now()
): { recoveries: RecoveryEvent[]; breakEvents: RecoveryEvent[] } {
  const n = candles.length
  const recoveries: RecoveryEvent[] = []
  const breakEvents: RecoveryEvent[] = []
  if (n < 2) return { recoveries, breakEvents }

  const lifetime = settings.breakSequenceLifetime > 0 ? settings.breakSequenceLifetime : settings.lookback
  let state = resetBreakState()

  // Explicitly iterate only closed candles — the caller must pass closed
  // candles; we still guard the last one for safety (reference excluded
  // the forming candle via loop bound; here it's already removed, but we
  // keep index parity by skipping i = n-1 ONLY when it is not closed).
  for (let i = 1; i < n; i++) {
    const candle = candles[i]
    // Safety: never process an unclosed candle
    if (candle.closeTime > now) break

    const prevLow = levels[i]?.prevDayLow
    const prevHigh = levels[i]?.prevDayHigh
    if (prevLow == null || prevHigh == null) continue

    const atrVal = atr[i] ?? 0
    const distLong = atrVal * settings.breakAtrMultiplierLong
    const distShort = atrVal * settings.breakAtrMultiplierShort

    // --- 1. Expiry ---
    if (state.active && !state.recovered && state.breakCandleIndex != null) {
      if (i - state.breakCandleIndex > lifetime) state = resetBreakState()
    }

    // --- 2/3. New break / replacement ---
    if (!state.active || state.recovered) {
      if (isMeaningfulBreak(candle, 'Long', prevLow, prevHigh, distLong, settings)) {
        state = { active: true, type: 'Long', breakCandleIndex: i, waitingRecovery: true, recovered: false, recoveryCandleIndex: null }
        breakEvents.push({ index: i, type: 'Long' })
      } else if (isMeaningfulBreak(candle, 'Short', prevLow, prevHigh, distShort, settings)) {
        state = { active: true, type: 'Short', breakCandleIndex: i, waitingRecovery: true, recovered: false, recoveryCandleIndex: null }
        breakEvents.push({ index: i, type: 'Short' })
      }
    } else if (state.active && !state.recovered && state.type) {
      // Opposite-direction break replaces the pending break
      const opposite: BreakType = state.type === 'Long' ? 'Short' : 'Long'
      const dist = opposite === 'Long' ? distLong : distShort
      if (isMeaningfulBreak(candle, opposite, prevLow, prevHigh, dist, settings)) {
        state = { active: true, type: opposite, breakCandleIndex: i, waitingRecovery: true, recovered: false, recoveryCandleIndex: null }
        breakEvents.push({ index: i, type: opposite })
      }
    }

    // --- 4. Recovery ---
    if (state.active && state.waitingRecovery && state.type) {
      const recovered =
        state.type === 'Long' ? candle.close > prevLow : candle.close < prevHigh
      if (recovered) {
        state.recovered = true
        state.waitingRecovery = false
        state.recoveryCandleIndex = i
        recoveries.push({ index: i, type: state.type })
      }
    }

    // --- 5. Consume the break on its recovery candle ---
    if (state.recovered && state.recoveryCandleIndex === i) {
      state = resetBreakState()
    }
  }

  return { recoveries, breakEvents }
}

export function isMeaningfulBreak(
  candle: Candle,
  type: BreakType,
  prevDayLow: number,
  prevDayHigh: number,
  distance: number,
  settings: AutomationSettings
): boolean {
  if (!settings.enableMeaningfulBreakFilter) {
    // Without the filter any cross of the level counts (legacy plain cross)
    return type === 'Long' ? candle.low <= prevDayLow : candle.high >= prevDayHigh
  }
  const useClose = settings.breakDetectionMethod === 'Close'
  if (type === 'Long') {
    const probe = useClose ? candle.close : candle.low
    return probe <= prevDayLow - distance
  }
  const probe = useClose ? candle.close : candle.high
  return probe >= prevDayHigh + distance
}

/**
 * Legacy (non-lifecycle) mode: returns indices where the close crossed
 * back inside the level with a recent break within `lookback` candles.
 */
export function runLegacySignals(
  candles: Candle[],
  levels: DailyLevelRow[],
  atr: (number | null)[],
  settings: AutomationSettings,
  now = Date.now()
): RecoveryEvent[] {
  const n = candles.length
  const events: RecoveryEvent[] = []
  if (n < 2) return events

  // Track candles-since-event (Infinity if never)
  let sinceBreakLong = Infinity
  let sinceBreakShort = Infinity

  for (let i = 1; i < n; i++) {
    const candle = candles[i]
    if (candle.closeTime > now) break
    const prevLow = levels[i]?.prevDayLow
    const prevHigh = levels[i]?.prevDayHigh
    const prevLowPrev = levels[i - 1]?.prevDayLow
    const prevHighPrev = levels[i - 1]?.prevDayHigh
    if (prevLow == null || prevHigh == null || prevLowPrev == null || prevHighPrev == null) {
      sinceBreakLong++
      sinceBreakShort++
      continue
    }

    const atrVal = atr[i] ?? 0
    const distLong = atrVal * settings.breakAtrMultiplierLong
    const distShort = atrVal * settings.breakAtrMultiplierShort

    // Cross-back conditions
    const isCrossOverPL = candle.close > prevLow && candles[i - 1].close <= prevLowPrev
    const isCrossUnderPH = candle.close < prevHigh && candles[i - 1].close >= prevHighPrev

    // Break trackers: with the meaningful filter → B.3 conditions;
    // without it → plain CLOSE cross beyond the level (reference behavior).
    let brokeLong: boolean
    let brokeShort: boolean
    if (settings.enableMeaningfulBreakFilter) {
      brokeLong = isMeaningfulBreak(candle, 'Long', prevLow, prevHigh, distLong, settings)
      brokeShort = isMeaningfulBreak(candle, 'Short', prevLow, prevHigh, distShort, settings)
    } else {
      brokeLong = candle.close <= prevLow
      brokeShort = candle.close >= prevHigh
    }

    if (isCrossOverPL && sinceBreakLong <= settings.lookback) {
      events.push({ index: i, type: 'Long' })
    }
    if (isCrossUnderPH && sinceBreakShort <= settings.lookback) {
      events.push({ index: i, type: 'Short' })
    }

    sinceBreakLong = brokeLong ? 0 : sinceBreakLong + 1
    sinceBreakShort = brokeShort ? 0 : sinceBreakShort + 1
  }
  return events
}
