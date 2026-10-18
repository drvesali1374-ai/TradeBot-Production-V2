/**
 * Core domain types — shared by server engine, API layer and UI.
 * Pure data structures only (no infra dependencies).
 */

/* ------------------------------------------------------------------ */
/* Candles                                                             */
/* ------------------------------------------------------------------ */

/** A single OHLCV candle, normalized from any exchange format. */
export interface Candle {
  /** Candle open time (ms epoch, UTC) */
  openTime: number
  /** Candle close time (ms epoch, exclusive: openTime + interval) */
  closeTime: number
  open: number
  high: number
  low: number
  close: number
  /** Volume in base asset (Toobit kline index 5 = amount) */
  volume: number
  /** RSI at this candle (aligned index) — filled by analysis */
  rsi?: number | null
  /** ATR at this candle (aligned index) */
  atr?: number | null
  /** Average volume (SMA) at this candle */
  avgVolume?: number | null
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

export type SignalSide = 'Long' | 'Short'

/** Signal lifecycle status (server-computed, single source of truth). */
export type SignalStatus = 'PENDING' | 'OPENED' | 'EXPIRED' | 'NOT_OPENED'

/**
 * A generated trading signal.
 * Times are explicitly separated (fixes the reference project's
 * conflation of candle-open time with signal confirmation time).
 */
export interface Signal {
  /** Stable unique id: {SYMBOL}_{LONG|SHORT}_{candleOpenTime}_v{STRATEGY_VERSION} */
  id: string
  symbol: string
  side: SignalSide
  /** Candle that confirmed the signal (recovery candle) */
  candleOpenTime: number
  candleCloseTime: number
  /** When the signal was confirmed by analysis (≈ candleCloseTime) */
  signalConfirmedAt: number
  /** Entry reference price = recovery candle close */
  price: number
  tp: number
  sl: number
  /** Index of the candle in the analyzed window (transient, UI-only) */
  candleIndex?: number
  /** Why this signal fired (human readable, fa) */
  reason?: string
}

/* ------------------------------------------------------------------ */
/* Analysis result                                                     */
/* ------------------------------------------------------------------ */

/** Daily levels for one candle row (previous Tehran day). */
export interface DailyLevelRow {
  prevDayHigh: number | null
  prevDayLow: number | null
  prevDayClose: number | null
}

export interface AnalysisResult {
  symbol: string
  interval: string
  /** All closed candles (forming candle excluded) */
  candles: Candle[]
  /** Latest price (from forming candle / ticker) */
  lastPrice: number | null
  signals: Signal[]
  /** The latest PENDING signal if any */
  pendingSignal: Signal | null
  dailyLevels: DailyLevelRow[]
  meta: {
    candleCount: number
    closedCount: number
    generatedAt: number
    strategyVersion: string
  }
}

/* ------------------------------------------------------------------ */
/* Positions / account                                                 */
/* ------------------------------------------------------------------ */

export interface BalanceInfo {
  asset: string
  total: number
  available: number
  free: number
  positionMargin: number
  orderMargin: number
  unrealizedPnL: number
  fetchedAt: number
}

export interface OpenPosition {
  symbol: string
  side: 'LONG' | 'SHORT'
  qty: number
  available: number
  margin: number
  leverage: number
  entryPrice: number
  markPrice: number
  unrealizedPnL: number
  profitRate: number
  /** TP/SL if known (demo mode tracks them; live mode from exchange when exposed) */
  takeProfit?: number | null
  stopLoss?: number | null
}

export interface ClosedPosition {
  id: string
  symbol: string
  side: 'LONG' | 'SHORT'
  qty: number
  entryPrice?: number | null
  closePrice: number
  closeTime: number
  realizedPnl: number
  realizedPnlRate: number
  leverage: number
  /** TP or SL hit (demo mode only; live unknown) */
  closeReason?: 'TP' | 'SL' | 'MANUAL' | 'UNKNOWN'
}

/* ------------------------------------------------------------------ */
/* Symbols (automation)                                                */
/* ------------------------------------------------------------------ */

export type SymbolStatus = 'waiting' | 'running' | 'error'

export interface SymbolEntry {
  id: number
  /** Short symbol name, e.g. "BTC" — full form is BTC-SWAP-USDT */
  name: string
  status: SymbolStatus
  errorCount: number
  lastCycleTime: number | null
}

/* ------------------------------------------------------------------ */
/* Cycle results                                                       */
/* ------------------------------------------------------------------ */

export type CycleAction =
  | 'NO_READY_SYMBOL'
  | 'MARKET_DATA_FAILED'
  | 'NO_SIGNAL'
  | 'SIGNAL_EXPIRED'
  | 'SIGNAL_STALE'
  | 'ALREADY_PROCESSED'
  | 'RISK_REJECTED'
  | 'POSITION_OPENED'
  | 'POSITION_OPENED_TPSL_FAILED'
  | 'OPPOSITE_CLOSED_THEN_OPENED'
  | 'ERROR'

export type StepStatus = 'ok' | 'info' | 'skipped' | 'warning' | 'failed'

export interface StepLog {
  step: number
  name: string
  status: StepStatus
  message: string
  data?: Record<string, unknown>
  durationMs?: number
  at: number
}

export interface CycleStorageBudget {
  reads: number
  writes: number
}

export interface CycleResult {
  cycleId: string
  symbol: string | null
  startedAt: number
  finishedAt: number
  durationMs: number
  source: 'manual' | 'cron'
  action: CycleAction
  reason?: string
  signal?: Signal | null
  order?: {
    orderId: string
    qty: number
    price: number
    tp: number | null
    sl: number | null
    tpslConfirmed: boolean
  } | null
  steps: StepLog[]
  logs: CycleLogEntry[]
  storage: CycleStorageBudget
  demo: boolean
  error?: string
}

export interface CycleLogEntry {
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
  symbol?: string
  timestamp: number
}

/* ------------------------------------------------------------------ */
/* Persisted log record (KV `logs` array, capped)                      */
/* ------------------------------------------------------------------ */

export interface LogRecord {
  id: number
  symbol: string | null
  action: string
  status: 'SUCCESS' | 'WARNING' | 'ERROR'
  message: string
  cycleId?: string
  details?: string
  created_at: string
}
