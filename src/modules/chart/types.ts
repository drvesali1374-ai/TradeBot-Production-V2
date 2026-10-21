/**
 * Chart module — shared client-side types.
 * Mirrors the JSON contracts of /api/market/* routes (no server imports so
 * this stays safe for the client bundle).
 */

/* ------------------------------------------------------------------ */
/* API contracts                                                       */
/* ------------------------------------------------------------------ */

/** OHLCV candle (klines + analysis endpoints; analysis also fills indicators). */
export interface Candle {
  openTime: number
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  /** RSI at this candle — present only in analysis candles. */
  rsi?: number | null
  /** ATR at this candle — present only in analysis candles. */
  atr?: number | null
  /** Volume SMA at this candle — present only in analysis candles. */
  avgVolume?: number | null
}

export type SignalSide = 'Long' | 'Short'
export type SignalStatus = 'PENDING' | 'OPENED' | 'EXPIRED' | 'NOT_OPENED'

export interface Signal {
  id: string
  symbol: string
  side: SignalSide
  candleOpenTime: number
  /** ms when the signal stops being actionable (pending window deadline). */
  signalCloseTime?: number
  candleCloseTime: number
  signalConfirmedAt: number
  price: number
  tp: number
  sl: number
  status?: SignalStatus
  reason?: string
}

export interface KlinesResponse {
  success: boolean
  candles: Candle[]
  interval: string
}

/**
 * A signal focus requested by navigation from the automation view's signals
 * table (mission §7). ChartView centers the loaded window on the bar that
 * CONTAINS signalTime, draws a marker + Entry/TP/SL lines for it.
 *
 * UNITS: signalTime = the signal's candleOpenTime in EPOCH MILLISECONDS
 * (Toobit kline rows are ms; lightweight-charts Time is SECONDS — ChartView
 * converts at the chart-API boundary only).
 */
export interface ChartFocusPayload {
  /** signal candleOpenTime — epoch MILLISECONDS */
  signalTime: number
  side?: SignalSide
  /** entry reference price (signal close) — enables the Entry price line */
  price?: number
  tp?: number
  sl?: number
  /** analysis signal id (marker/legend dedupe aid) */
  signalId?: string
}

export interface TickerResponse {
  success: boolean
  price: number
  symbol?: string
}

export interface AnalysisResponse {
  success: boolean
  symbol: string
  interval: string
  candles: Candle[]
  lastPrice: number | null
  signals: Signal[]
  pendingSignal: Signal | null
  meta: {
    candleCount: number
    closedCount: number
    generatedAt: number
    strategyVersion: string
  }
}

/* ------------------------------------------------------------------ */
/* UI constants                                                        */
/* ------------------------------------------------------------------ */

export const SYMBOLS: readonly string[] = ['BTC', 'ETH', 'DOT', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK']

export const INTERVALS: readonly string[] = ['15m', '30m', '1h', '4h', '1d']

/** Interval → candle duration in ms (used by the measure tool & marker snapping). */
export const INTERVAL_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
}

/* ------------------------------------------------------------------ */
/* Drawing tools                                                       */
/* ------------------------------------------------------------------ */

export type DrawingToolId = 'none' | 'hline' | 'vline' | 'trend' | 'rect' | 'measure'
export type DrawingType = Exclude<DrawingToolId, 'none'>

/**
 * A stored drawing — LOGICAL coordinates only (UNIX-second bar time + price),
 * so shapes keep their anchor while the user pans/zooms/rescales the chart.
 * Pixels are re-derived from the chart scales on every redraw.
 */
export interface Drawing {
  id: number
  type: DrawingType
  /** anchor 1 (for hline only price1 is meaningful; for vline only time1). */
  time1: number
  price1: number
  time2: number
  price2: number
  /** user-chosen stroke color (drawings are editable); missing → theme accent */
  color?: string
}

/** Palette offered in the drawing editor (theme-neutral trading colors). */
export const DRAW_COLORS: readonly string[] = [
  '#6366f1', // accent (theme default)
  '#10b981', // emerald
  '#ef4444', // red
  '#f59e0b', // amber
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ec4899', // pink
  '#64748b', // slate
]

/** In-progress two-point drawing (start anchored logically, end follows the mouse). */
export interface DrawingDraft {
  type: 'trend' | 'rect' | 'measure'
  time1: number
  price1: number
  time2: number
  price2: number
}
