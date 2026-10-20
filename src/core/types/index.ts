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

/**
 * Open position — internal contract (converted from Toobit's raw payload
 * in exactly ONE place: normalizePosition in toobit/client.ts).
 *
 * UNITS: `unrealizedPnL` / `margin` = USDT; `profitRate` = PERCENT units
 * (Toobit's raw fraction is multiplied by 100 at the normalizer — raw
 * "0.003" becomes 0.3 percent here).
 *
 * NULLABILITY: any field the exchange did not provide or provided in an
 * invalid format is `null` — the UI must show «نامشخص», never a fake zero.
 */
export interface OpenPosition {
  symbol: string
  side: 'LONG' | 'SHORT'
  qty: number | null
  available: number | null
  margin: number | null
  leverage: number | null
  entryPrice: number | null
  markPrice: number | null
  unrealizedPnL: number | null
  /** PnL rate in PERCENT units (fraction ×100 at the normalizer) */
  profitRate: number | null
  /** Toobit's positions endpoint does not expose TP/SL — null until exposed */
  takeProfit?: number | null
  stopLoss?: number | null
}

/** Closed position — `realizedPnlRate` in PERCENT units (fraction ×100). */
export interface ClosedPosition {
  id: string
  symbol: string
  side: 'LONG' | 'SHORT'
  qty: number | null
  entryPrice?: number | null
  closePrice: number
  closeTime: number
  realizedPnl: number
  realizedPnlRate: number
  leverage: number
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
  storage: CycleStorageBudget
  error?: string
}

/* ------------------------------------------------------------------ */
/* Persisted log record (KV `logs` array, capped)                      */
/* ------------------------------------------------------------------ */

export type LogStatus = 'SUCCESS' | 'INFO' | 'SKIPPED' | 'WARNING' | 'ERROR'

/**
 * Reference event model (mission §5): one row per real operational event.
 * Every cycle step becomes exactly one record — persisted in a SINGLE
 * batched KV write at the end of the cycle (never per-step writes).
 *
 * Backward compatibility: rows written by older versions lack the new
 * fields (`process`, `source`, `durationMs`, `step`) — consumers must
 * fall back to `action` when `process` is absent.
 */
export interface LogRecord {
  id: number
  symbol: string | null
  /** Legacy action tag (e.g. 'automation_cycle', 'settings') */
  action: string
  /** The real process name (cycle step / operation), e.g. 'ثبت سفارش' */
  process?: string
  status: LogStatus
  message: string
  cycleId?: string
  /** Structured or stringified technical details (secret-free) */
  details?: string | Record<string, unknown>
  /** 'manual' | 'cron' | 'system' — who triggered the owning cycle/op */
  source?: 'manual' | 'cron' | 'system'
  durationMs?: number | null
  /** Step ordinal within its cycle (when applicable) */
  step?: number | null
  created_at: string
}
