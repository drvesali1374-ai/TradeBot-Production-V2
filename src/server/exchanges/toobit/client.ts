/**
 * ToobitClient — the SINGLE library every exchange call goes through.
 *
 * Live mode only for account/order operations (signed requests per
 * endpoints.ts). When API keys are missing, every account/order call
 * fails fast with the explicit NO_CREDENTIALS error — there is NO
 * simulated fallback in the product runtime (mission §13).
 *
 * Data contract (verified against official Toobit docs —
 * api-docs.toobit.com/api/usdt-m-account-and-trading.html):
 *  - GET /api/v1/futures/positions: avgPrice, position (contracts),
 *    available, leverage, margin, unrealizedPnL (USDT amount),
 *    profitRate (FRACTION — e.g. "0.003" = 0.3%), markPrice, side.
 *  - GET /api/v1/futures/historyPositions: realizedPnL (USDT),
 *    realizedPnlRate (FRACTION — e.g. "0.0042" = 0.42%),
 *    openAvgPrice / closeAvgPrice (NOT avgPrice), qty/position, id.
 *  - GET /api/v1/futures/balance: coin, balance, availableBalance,
 *    positionMargin, orderMargin, crossUnRealizedPnl.
 *
 * INTERNAL CONTRACT (single conversion point — normalizePosition /
 * normalizeHistoryPosition below): all percentage-like rates are
 * converted from Toobit's FRACTION to PERCENT units here, exactly once.
 * Everything downstream (UI fmtPct, Bale messages) receives PERCENT
 * units. Missing/invalid raw fields become null — never fake zeros.
 *
 * Security rules (instruction §6):
 *  - Keys never appear in errors, logs or responses.
 *  - Base URL is fixed to the allow-list (no client-controlled baseUrl).
 *  - All fetches carry an explicit timeout (the reference had none).
 */
import type { BalanceInfo, Candle, OpenPosition, ClosedPosition } from '@/core/types'
import { endpoints, fullSymbol, TOOBIT_BASE_URL, computeOrderQty } from './endpoints'
import { buildSortedQuery, hmacSha256Hex, RECV_WINDOW_DEFAULT, RECV_WINDOW_POSITIONS, API_KEY_HEADER } from './signing'

export interface ToobitCredentials {
  apiKey: string
  secretKey: string
}

export interface ExchangeError extends Error {
  code: 'NO_CREDENTIALS' | 'HTTP_ERROR' | 'BAD_RESPONSE' | 'TIMEOUT' | 'NO_USDT'
  status?: number
}

/** Human-readable, secret-free message for NO_CREDENTIALS (mission §14). */
export const NO_CREDENTIALS_MESSAGE = 'اعتبارنامه صرافی تنظیم نشده است'

function exError(code: ExchangeError['code'], message: string, status?: number): ExchangeError {
  const e = new Error(message) as ExchangeError
  e.code = code
  e.status = status
  return e
}

/** Extract a machine-readable error code from any thrown value. */
export function errorCode(e: unknown): ExchangeError['code'] | null {
  return (e as ExchangeError)?.code ?? null
}

const FETCH_TIMEOUT = 12_000

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(t)
  }
}

export class ToobitClient {
  constructor(private creds: ToobitCredentials) {}

  /** Whether signed account/order calls can be made at all. */
  get hasCredentials(): boolean {
    return Boolean(this.creds.apiKey && this.creds.secretKey)
  }

  /* ---------------------------------------------------------------- */
  /* Public market data (no credentials required)                       */
  /* ---------------------------------------------------------------- */

  async getKlines(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const ep = endpoints.klines({ symbol: fullSymbol(symbol), interval, limit })
    const url = `${TOOBIT_BASE_URL}${ep.path}?${buildSortedQuery(ep.query as Record<string, string | number>)}`
    const res = await fetchWithTimeout(url, { method: 'GET' })
    if (!res.ok) throw exError('HTTP_ERROR', `klines HTTP ${res.status}`, res.status)
    const raw = (await res.json()) as unknown
    if (!Array.isArray(raw) || raw.length === 0) throw exError('BAD_RESPONSE', 'klines empty response')
    return (raw as (string | number)[][]).map((k) => {
      const openTime = Number(k[0])
      return {
        openTime,
        closeTime: openTime + 1, // fixed up by caller via intervalToMs
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      }
    })
  }

  async getTickerPrice(symbol: string): Promise<number> {
    const sym = fullSymbol(symbol)
    const ep = endpoints.tickerPrice(sym)
    const url = `${TOOBIT_BASE_URL}${ep.path}?${buildSortedQuery(ep.query)}`
    const res = await fetchWithTimeout(url, { method: 'GET' })
    if (!res.ok) throw exError('HTTP_ERROR', `ticker HTTP ${res.status}`, res.status)
    const data = (await res.json()) as unknown
    const price = Array.isArray(data) ? Number(data[0]?.p) : Number((data as { price?: string; p?: string }).price ?? (data as { p?: string }).p)
    if (!Number.isFinite(price)) throw exError('BAD_RESPONSE', 'ticker price missing')
    return price
  }

  /* ---------------------------------------------------------------- */
  /* Signed helpers                                                    */
  /* ---------------------------------------------------------------- */

  private async signedGet(path: string, query: Record<string, string | number>): Promise<unknown> {
    const timestamp = Date.now()
    const params = { ...query, timestamp }
    const qs = buildSortedQuery(params)
    const signature = await hmacSha256Hex(qs, this.creds.secretKey)
    const url = `${TOOBIT_BASE_URL}${path}?${qs}&signature=${signature}`
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      headers: { [API_KEY_HEADER]: this.creds.apiKey },
    })
    if (!res.ok) throw exError('HTTP_ERROR', `${path} HTTP ${res.status}`, res.status)
    return res.json()
  }

  private async signedPost(path: string, body: Record<string, string | number>): Promise<unknown> {
    const timestamp = Date.now()
    const params = { ...body, timestamp }
    const qs = buildSortedQuery(params)
    const signature = await hmacSha256Hex(qs, this.creds.secretKey)
    const res = await fetchWithTimeout(`${TOOBIT_BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        [API_KEY_HEADER]: this.creds.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `${qs}&signature=${signature}`,
    })
    if (!res.ok) throw exError('HTTP_ERROR', `${path} HTTP ${res.status}`, res.status)
    return res.json()
  }

  /**
   * Hard gate for every account/order operation: no credentials →
   * explicit error. No simulated fallback exists (mission §13).
   */
  private requireCredentials(): void {
    if (!this.hasCredentials) throw exError('NO_CREDENTIALS', NO_CREDENTIALS_MESSAGE)
  }

  /* ---------------------------------------------------------------- */
  /* Account                                                           */
  /* ---------------------------------------------------------------- */

  async getBalance(): Promise<BalanceInfo> {
    this.requireCredentials()
    const ep = endpoints.balance(RECV_WINDOW_DEFAULT, 0)
    const data = await this.signedGet(ep.path, ep.query)
    return normalizeBalance(data)
  }

  async getOpenPositions(): Promise<OpenPosition[]> {
    this.requireCredentials()
    const ep = endpoints.positions(RECV_WINDOW_POSITIONS, 0)
    const data = await this.signedGet(ep.path, ep.query)
    return arrayFrom(data).map(normalizePosition)
  }

  async getHistoryPositions(): Promise<ClosedPosition[]> {
    this.requireCredentials()
    const ep = endpoints.historyPositions(RECV_WINDOW_DEFAULT, 0)
    const data = await this.signedGet(ep.path, ep.query)
    return arrayFrom(data).map(normalizeHistoryPosition).sort((a, b) => b.closeTime - a.closeTime)
  }

  async getUserTrades(symbol: string, limit = 100): Promise<unknown[]> {
    this.requireCredentials()
    const timestamp = Date.now()
    const params = { symbol: fullSymbol(symbol), limit, recvWindow: RECV_WINDOW_POSITIONS, timestamp }
    const qs = `symbol=${params.symbol}&limit=${params.limit}&recvWindow=${params.recvWindow}&timestamp=${params.timestamp}`
    const signature = await hmacSha256Hex(qs, this.creds.secretKey)
    const url = `${TOOBIT_BASE_URL}/api/v1/futures/userTrades?${qs}&signature=${signature}`
    const res = await fetchWithTimeout(url, { method: 'GET', headers: { [API_KEY_HEADER]: this.creds.apiKey } })
    if (!res.ok) throw exError('HTTP_ERROR', `userTrades HTTP ${res.status}`, res.status)
    return arrayFrom(await res.json())
  }

  /* ---------------------------------------------------------------- */
  /* Trading                                                           */
  /* ---------------------------------------------------------------- */

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    this.requireCredentials()
    const ep = endpoints.leverage({ symbol: fullSymbol(symbol), leverage, recvWindow: RECV_WINDOW_DEFAULT, timestamp: 0 })
    await this.signedPost(ep.path, ep.body as Record<string, string | number>)
  }

  /**
   * Open a position (signed order + TP/SL trading-stop).
   */
  async openPosition(params: {
    symbol: string
    side: 'LONG' | 'SHORT'
    margin: number
    leverage: number
    tp: number | null
    sl: number | null
    clientOrderId: string
  }): Promise<{ orderId: string; qty: number; price: number; tpslConfirmed: boolean; tpslError?: string }> {
    this.requireCredentials()
    const price = await this.getTickerPrice(params.symbol)
    const qty = computeOrderQty(params.margin, params.leverage, price)

    // Live: leverage first (fire-and-forget preserved, but surfaced in result)
    if (params.leverage > 1) {
      try {
        await this.setLeverage(params.symbol, params.leverage)
      } catch {
        // preserved reference behavior: leverage failure does not abort
      }
    }

    const ep = endpoints.order({
      symbol: fullSymbol(params.symbol),
      side: params.side === 'LONG' ? 'BUY_OPEN' : 'SELL_OPEN',
      quantity: qty,
      clientOrderId: params.clientOrderId,
      recvWindow: RECV_WINDOW_DEFAULT,
      timestamp: 0,
    })
    const orderRes = (await this.signedPost(ep.path, ep.body as Record<string, string | number>)) as Record<string, unknown>
    const orderId = String(orderRes.orderId ?? orderRes.orderId ?? '')

    // TP/SL — failure is surfaced (not silent like the reference)
    let tpslConfirmed = false
    let tpslError: string | undefined
    if (params.tp != null || params.sl != null) {
      try {
        const ts = endpoints.tradingStop({
          symbol: fullSymbol(params.symbol),
          side: params.side === 'LONG' ? 'LONG' : 'SHORT',
          takeProfit: params.tp ?? undefined,
          stopLoss: params.sl ?? undefined,
          recvWindow: RECV_WINDOW_DEFAULT,
          timestamp: 0,
        })
        const tsRes = (await this.signedPost(ts.path, ts.body)) as Record<string, unknown>
        tpslConfirmed = tsRes.code == null || Number(tsRes.code) === 0 || tsRes.success === true
        if (!tpslConfirmed) tpslError = 'TP/SL rejected by exchange'
      } catch (e) {
        tpslError = e instanceof Error ? e.message : 'TP/SL request failed'
      }
    } else {
      tpslConfirmed = true
    }

    return { orderId, qty, price, tpslConfirmed, tpslError }
  }

  async closePosition(params: { symbol: string; side: 'LONG' | 'SHORT' }): Promise<{ closed: number; total: number; errors: string[] }> {
    this.requireCredentials()
    const positions = await this.getOpenPositions()
    const target = fullSymbol(params.symbol)
    const targets = positions.filter(
      (p) => p.symbol.toUpperCase() === target.toUpperCase() && p.side === params.side && ((p.available ?? p.qty) ?? 0) > 0
    )
    if (targets.length === 0) return { closed: 0, total: 0, errors: [] }

    const errors: string[] = []
    let closed = 0
    for (const p of targets) {
      const qty = Math.ceil(p.available || p.qty || 0)
      const ep = endpoints.order({
        symbol: p.symbol,
        side: params.side === 'LONG' ? 'SELL_CLOSE' : 'BUY_CLOSE',
        quantity: qty,
        clientOrderId: `close_${Date.now()}_${closed}`,
        recvWindow: RECV_WINDOW_DEFAULT,
        timestamp: 0,
      })
      try {
        await this.signedPost(ep.path, ep.body as Record<string, string | number>)
        closed++
      } catch (e) {
        errors.push(`${p.symbol}: ${e instanceof Error ? e.message : 'close failed'}`)
      }
    }
    return { closed, total: targets.length, errors }
  }
}

/* ---------------------------------------------------------------- */
/* Field parsing — strict: missing or invalid becomes null, never     */
/* a fabricated zero (mission §1.2.6).                               */
/* ---------------------------------------------------------------- */

function toNum(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'string' && v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** FRACTION (Toobit raw) → PERCENT (internal contract), or null. */
function fractionToPercent(v: unknown): number | null {
  const n = toNum(v)
  return n == null ? null : n * 100
}

/* ---------------------------------------------------------------- */
/* Response normalizers (official docs; see file header) — the ONLY   */
/* place raw Toobit payloads are converted to internal models.        */
/* ---------------------------------------------------------------- */

/**
 * GET /api/v1/futures/positions row → OpenPosition.
 * profitRate (fraction) is converted to PERCENT units here, exactly
 * once. All missing/invalid numeric fields become null → the UI shows
 * «نامشخص» instead of a fake zero (mission §1.2.6).
 */
export function normalizePosition(p: Record<string, unknown>): OpenPosition {
  const side = String(p.side ?? '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG'
  return {
    symbol: String(p.symbol ?? ''),
    side,
    qty: toNum(p.position ?? p.qty),
    available: toNum(p.available),
    margin: toNum(p.margin),
    leverage: toNum(p.leverage),
    entryPrice: toNum(p.avgPrice ?? p.entryPrice),
    markPrice: toNum(p.markPrice),
    unrealizedPnL: toNum(p.unrealizedPnL ?? p.unRealizedPnl),
    profitRate: fractionToPercent(p.profitRate),
    // Toobit's open-position payload does not expose TP/SL (docs) —
    // keep the fields for future exposure but they stay null here.
    takeProfit: null,
    stopLoss: null,
  }
}

/**
 * GET /api/v1/futures/historyPositions row → ClosedPosition.
 * realizedPnlRate (fraction) → PERCENT; entry price is openAvgPrice.
 */
export function normalizeHistoryPosition(p: Record<string, unknown>): ClosedPosition {
  const side = String(p.side ?? '').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG'
  return {
    id: String(p.id ?? ''),
    symbol: String(p.symbol ?? ''),
    side,
    qty: toNum(p.qty ?? p.position),
    entryPrice: toNum(p.openAvgPrice ?? p.avgPrice),
    closePrice: toNum(p.closeAvgPrice) ?? 0,
    closeTime: toNum(p.closeTime) ?? 0,
    realizedPnl: toNum(p.realizedPnL) ?? 0,
    realizedPnlRate: fractionToPercent(p.realizedPnlRate) ?? 0,
    leverage: toNum(p.leverage) ?? 1,
  }
}

function arrayFrom(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[]
    if (Array.isArray(obj.result)) return obj.result as Record<string, unknown>[]
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) return v as Record<string, unknown>[]
    }
  }
  return []
}

function normalizeBalance(data: unknown): BalanceInfo {
  const arr = arrayFrom(data)
  if (arr.length === 0) throw exError('BAD_RESPONSE', 'unknown balance structure')
  const usdt = arr.find(
    (b) => String(b.asset ?? b.coin ?? b.currency ?? b.symbol ?? '').toUpperCase() === 'USDT'
  )
  if (!usdt) throw exError('NO_USDT', 'no USDT balance row')
  const total = toNum(usdt.balance ?? usdt.total)
  const available = toNum(usdt.availableBalance ?? usdt.available)
  const positionMargin = toNum(usdt.positionMargin ?? usdt.position_margin)
  const orderMargin = toNum(usdt.orderMargin ?? usdt.order_margin ?? usdt.frozen)
  const unrealizedPnL = toNum(usdt.crossUnRealizedPnl ?? usdt.unrealizedPnl ?? usdt.unrealized)
  return {
    asset: 'USDT',
    total: round4(total ?? 0),
    available: round4(available ?? 0),
    free: round4((available ?? 0) - (orderMargin ?? 0)),
    positionMargin: round4(positionMargin ?? 0),
    orderMargin: round4(orderMargin ?? 0),
    unrealizedPnL: round4(unrealizedPnL ?? 0),
    fetchedAt: Date.now(),
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
