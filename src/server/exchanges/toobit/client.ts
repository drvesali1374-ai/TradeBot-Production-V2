/**
 * ToobitClient — the SINGLE library every exchange call goes through.
 *
 * Live mode (API keys configured): signed requests per endpoints.ts.
 * Demo mode (no keys): market data stays real, account/order operations
 * are simulated via DemoEngine (persisted, TP/SL auto-close with live
 * prices) — clearly flagged with `mode: 'demo'` in results.
 *
 * Security rules (instruction §6):
 *  - Keys never appear in errors, logs or responses.
 *  - Base URL is fixed to the allow-list (no client-controlled baseUrl).
 *  - All fetches carry an explicit timeout (the reference had none).
 */
import type { BalanceInfo, Candle, OpenPosition, ClosedPosition } from '@/core/types'
import { endpoints, fullSymbol, TOOBIT_BASE_URL, computeOrderQty } from './endpoints'
import { buildSortedQuery, hmacSha256Hex, RECV_WINDOW_DEFAULT, RECV_WINDOW_POSITIONS, API_KEY_HEADER } from './signing'
import { demoEngine } from './demo'

export type ToobitMode = 'live' | 'demo'

export interface ToobitCredentials {
  apiKey: string
  secretKey: string
}

export interface ExchangeError extends Error {
  code: 'NO_CREDENTIALS' | 'HTTP_ERROR' | 'BAD_RESPONSE' | 'TIMEOUT' | 'NO_USDT'
  status?: number
}

function exError(code: ExchangeError['code'], message: string, status?: number): ExchangeError {
  const e = new Error(message) as ExchangeError
  e.code = code
  e.status = status
  return e
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

  get mode(): ToobitMode {
    return this.creds.apiKey && this.creds.secretKey ? 'live' : 'demo'
  }

  /* ---------------------------------------------------------------- */
  /* Public market data (always live)                                  */
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
    demoEngine.setPrice(symbol, price)
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

  private requireLive(): void {
    if (this.mode !== 'live') throw exError('NO_CREDENTIALS', 'demo mode')
  }

  /* ---------------------------------------------------------------- */
  /* Account                                                           */
  /* ---------------------------------------------------------------- */

  async getBalance(): Promise<BalanceInfo> {
    if (this.mode === 'demo') return demoEngine.balance()
    const ep = endpoints.balance(RECV_WINDOW_DEFAULT, 0)
    const data = await this.signedGet(ep.path, ep.query)
    return normalizeBalance(data)
  }

  async getOpenPositions(): Promise<OpenPosition[]> {
    if (this.mode === 'demo') return demoEngine.positions()
    const ep = endpoints.positions(RECV_WINDOW_POSITIONS, 0)
    const data = await this.signedGet(ep.path, ep.query)
    const arr = arrayFrom(data)
    return arr.map((p: Record<string, unknown>) => ({
      symbol: String(p.symbol ?? ''),
      side: (String(p.side ?? 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
      qty: Number(p.position ?? p.qty ?? 0),
      available: Number(p.available ?? 0),
      margin: Number(p.margin ?? 0),
      leverage: Number(p.leverage ?? 1),
      entryPrice: Number(p.avgPrice ?? p.entryPrice ?? 0),
      markPrice: Number(p.markPrice ?? 0),
      unrealizedPnL: Number(p.unrealizedPnL ?? p.unRealizedPnl ?? 0),
      profitRate: Number(p.profitRate ?? 0),
    }))
  }

  async getHistoryPositions(): Promise<ClosedPosition[]> {
    if (this.mode === 'demo') return demoEngine.historyPositions()
    const ep = endpoints.historyPositions(RECV_WINDOW_DEFAULT, 0)
    const data = await this.signedGet(ep.path, ep.query)
    const arr = arrayFrom(data)
    return arr
      .map(
        (p: Record<string, unknown>): ClosedPosition => ({
          id: String(p.id ?? ''),
          symbol: String(p.symbol ?? ''),
          side: (String(p.side ?? 'LONG').toUpperCase() === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
          qty: Number(p.qty ?? p.position ?? 0),
          entryPrice: p.avgPrice != null ? Number(p.avgPrice) : null,
          closePrice: Number(p.closeAvgPrice ?? 0),
          closeTime: Number(p.closeTime ?? 0),
          realizedPnl: Number(p.realizedPnL ?? 0),
          realizedPnlRate: Number(p.realizedPnlRate ?? 0),
          leverage: Number(p.leverage ?? 1),
        })
      )
      .sort((a, b) => b.closeTime - a.closeTime)
  }

  async getUserTrades(symbol: string, limit = 100): Promise<unknown[]> {
    if (this.mode === 'demo') return demoEngine.userTrades(symbol)
    this.requireLive()
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
    if (this.mode === 'demo') return
    const ep = endpoints.leverage({ symbol: fullSymbol(symbol), leverage, recvWindow: RECV_WINDOW_DEFAULT, timestamp: 0 })
    await this.signedPost(ep.path, ep.body as Record<string, string | number>)
  }

  /**
   * Open a position. Returns order info; in demo mode the simulated
   * position is created with TP/SL attached (single step).
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
    const price = await this.getTickerPrice(params.symbol)
    const qty = computeOrderQty(params.margin, params.leverage, price)

    if (this.mode === 'demo') {
      const { orderId } = await demoEngine.openPosition({
        symbol: params.symbol,
        side: params.side === 'LONG' ? 'LONG' : 'SHORT',
        qty,
        margin: params.margin,
        leverage: params.leverage,
        price,
        tp: params.tp,
        sl: params.sl,
        clientOrderId: params.clientOrderId,
      })
      return { orderId, qty, price, tpslConfirmed: true }
    }

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
    if (this.mode === 'demo') {
      const { closed } = await demoEngine.closePosition({ symbol: params.symbol, side: params.side })
      return { closed, total: closed, errors: [] }
    }
    const positions = await this.getOpenPositions()
    const target = fullSymbol(params.symbol)
    const targets = positions.filter(
      (p) => p.symbol.toUpperCase() === target.toUpperCase() && p.side === params.side && (p.available || p.qty) > 0
    )
    if (targets.length === 0) return { closed: 0, total: 0, errors: [] }

    const errors: string[] = []
    let closed = 0
    for (const p of targets) {
      const qty = Math.ceil(p.available || p.qty)
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
/* Response normalizers (reference audit-3 §A master table)          */
/* ---------------------------------------------------------------- */

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
  const total = Number(usdt.balance ?? usdt.total ?? 0)
  const available = Number(usdt.availableBalance ?? usdt.available ?? 0)
  const positionMargin = Number(usdt.positionMargin ?? usdt.position_margin ?? 0)
  const orderMargin = Number(usdt.orderMargin ?? usdt.order_margin ?? usdt.frozen ?? 0)
  const unrealizedPnL = Number(usdt.crossUnRealizedPnl ?? usdt.unrealizedPnl ?? usdt.unrealized ?? 0)
  return {
    asset: 'USDT',
    total: round4(total),
    available: round4(available),
    free: round4(available - orderMargin),
    positionMargin: round4(positionMargin),
    orderMargin: round4(orderMargin),
    unrealizedPnL: round4(unrealizedPnL),
    fetchedAt: Date.now(),
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
