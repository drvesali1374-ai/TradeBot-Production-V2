/**
 * Signal generation — single source of truth.
 *
 * Combines: closed candles → indicators → daily levels → fake-breakout
 * state machine → entry filters → TP/SL.
 *
 * Entry filters on the recovery candle (audit-2 §B.5):
 *   Long:  volume > avgVol × volMultLong  && rsi < rsiLongThreshold && htf
 *   Short: volume > avgVol × volMultShort && rsi > rsiShortThreshold && htf
 *
 * TP/SL (audit-2 §B.8) — fixed values are PERCENT of entry (null = ATR):
 *   Long:  tp = close + close×tp%   | close + atr×tpLongMult
 *          sl = close − close×sl%   | close − atr×slLongMult
 *   Short: mirrored.
 */
import type { Candle, Signal, SignalSide } from '../types'
import type { DailyLevelRow } from '../types'
import type { AutomationSettings } from '../settings'
import { STRATEGY_VERSION } from '../settings'
import { calculateRSI, calculateATR, calculateSMA } from '../indicators'
import { computeDailyLevels } from '../strategy/daily-levels'
import { runBreakLifecycle, runLegacySignals, type RecoveryEvent } from '../strategy/fake-breakout'
import { splitClosedCandles } from '../time/candles'

export function buildSignalId(symbol: string, side: SignalSide, candleOpenTime: number): string {
  return `${symbol.toUpperCase()}_${side.toUpperCase()}_${candleOpenTime}_${STRATEGY_VERSION}`
}

export function computeTPSL(
  side: SignalSide,
  entryPrice: number,
  atrValue: number | null,
  settings: AutomationSettings
): { tp: number; sl: number } {
  if (side === 'Long') {
    const tp =
      settings.longFixedTp != null && !Number.isNaN(settings.longFixedTp)
        ? entryPrice + (entryPrice * settings.longFixedTp) / 100
        : entryPrice + (atrValue ?? 0) * settings.tpLongMult
    const sl =
      settings.longFixedSl != null && !Number.isNaN(settings.longFixedSl)
        ? entryPrice - (entryPrice * settings.longFixedSl) / 100
        : entryPrice - (atrValue ?? 0) * settings.slLongMult
    return { tp, sl }
  }
  const tp =
    settings.shortFixedTp != null && !Number.isNaN(settings.shortFixedTp)
      ? entryPrice - (entryPrice * settings.shortFixedTp) / 100
      : entryPrice - (atrValue ?? 0) * settings.tpShortMult
  const sl =
    settings.shortFixedSl != null && !Number.isNaN(settings.shortFixedSl)
      ? entryPrice + (entryPrice * settings.shortFixedSl) / 100
      : entryPrice + (atrValue ?? 0) * settings.slShortMult
  return { tp, sl }
}

/** HTF confirmation (audit-2 §B.7) — default signalCandleClose. */
export function htfConfirms(
  candle: Candle,
  levels: DailyLevelRow,
  settings: AutomationSettings,
  side: SignalSide
): boolean {
  if (settings.htfConfirmationSource === 'previousDayClose') {
    if (levels.prevDayClose == null) return false
    return side === 'Long'
      ? levels.prevDayClose > (levels.prevDayLow ?? -Infinity)
      : levels.prevDayClose < (levels.prevDayHigh ?? Infinity)
  }
  // signalCandleClose (default): signal candle's close back inside prior-day range
  return side === 'Long'
    ? candle.close > (levels.prevDayLow ?? -Infinity)
    : candle.close < (levels.prevDayHigh ?? Infinity)
}

export interface AnalyzeOptions {
  symbol: string
  candles: Candle[]
  settings: AutomationSettings
  now?: number
}

/**
 * Full analysis of one symbol. `candles` may include the forming candle
 * (it is filtered out explicitly); indicators are computed on the full
 * array but signals only from closed candles.
 */
export function analyzeSymbol(options: AnalyzeOptions): {
  closedCandles: Candle[]
  allCandles: Candle[]
  signals: Signal[]
  lastPrice: number | null
  dailyLevels: DailyLevelRow[]
  meta: { candleCount: number; closedCount: number; generatedAt: number; strategyVersion: string }
} {
  const { symbol, candles, settings } = options
  const now = options.now ?? Date.now()

  const { closed, forming } = splitClosedCandles(candles, now)

  // Indicators on ALL candles (so the forming row can display live RSI)
  const rsi = calculateRSI(candles, settings.rsiPeriod)
  const atr = calculateATR(candles, settings.atrPeriod)
  const avgVols = calculateSMA(candles.map((c) => c.volume), settings.avgVolPeriod)
  for (let i = 0; i < candles.length; i++) {
    candles[i].rsi = rsi[i]
    candles[i].atr = atr[i]
    candles[i].avgVolume = avgVols[i]
  }

  const { rows } = computeDailyLevels(candles)

  // Signals from CLOSED candles only. Klines are time-sorted, so the
  // closed window is a prefix of the full array: closed[i] === candles[i].
  const closedLevels = rows.slice(0, closed.length)

  let events: RecoveryEvent[]
  if (settings.enableBreakLifecycleManagement) {
    events = runBreakLifecycle(closed, closedLevels, atr, settings, now).recoveries
  } else {
    events = runLegacySignals(closed, closedLevels, atr, settings, now)
  }

  const signals: Signal[] = []
  for (const ev of events) {
    const candle = closed[ev.index]
    const levels = closedLevels[ev.index]
    if (!candle || !levels) continue

    const volumeOk =
      candle.avgVolume != null && candle.volume > candle.avgVolume * (ev.type === 'Long' ? settings.volMultLong : settings.volMultShort)
    const rsiVal = candle.rsi
    const rsiOk =
      rsiVal != null &&
      (ev.type === 'Long' ? rsiVal < settings.rsiLongThreshold : rsiVal > settings.rsiShortThreshold)
    const htfOk = htfConfirms(candle, levels, settings, ev.type)

    if (volumeOk && rsiOk && htfOk) {
      const { tp, sl } = computeTPSL(ev.type, candle.close, candle.atr ?? null, settings)
      signals.push({
        id: buildSignalId(symbol, ev.type, candle.openTime),
        symbol: symbol.toUpperCase(),
        side: ev.type,
        candleOpenTime: candle.openTime,
        candleCloseTime: candle.closeTime,
        signalConfirmedAt: candle.closeTime,
        price: candle.close,
        tp,
        sl,
        candleIndex: ev.index,
        reason:
          ev.type === 'Long'
            ? `شکست کاذب سمت پایین روز قبل + بازیابی قیمت`
            : `شکست کاذب سمت بالای روز قبل + بازیابی قیمت`,
      })
    }
  }

  const lastPrice = forming ? forming.close : closed.length ? closed[closed.length - 1].close : null

  return {
    closedCandles: closed,
    allCandles: candles,
    signals,
    lastPrice,
    dailyLevels: rows,
    meta: {
      candleCount: candles.length,
      closedCount: closed.length,
      generatedAt: now,
      strategyVersion: STRATEGY_VERSION,
    },
  }
}
