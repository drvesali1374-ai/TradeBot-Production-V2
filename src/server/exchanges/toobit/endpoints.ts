/**
 * Toobit endpoint catalog — the ONLY place exchange URLs are defined.
 * Extracted verbatim from the audited reference (audit-3 §A); do not
 * guess endpoints, update here only with verified documentation.
 */
export const TOOBIT_BASE_URL = 'https://api.toobit.com'

export const endpoints = {
  /** Public — klines (candles). Symbol accepts {S}-SWAP-USDT or {S}USDT. */
  klines: (params: { symbol: string; interval: string; limit: number }) => ({
    method: 'GET' as const,
    path: '/quote/v1/klines',
    query: params,
    signed: false,
  }),
  /** Public — latest ticker price. */
  tickerPrice: (symbol: string) => ({
    method: 'GET' as const,
    path: '/quote/v1/ticker/price',
    query: { symbol },
    signed: false,
  }),
  /** Signed — futures account balance. */
  balance: (recvWindow: number, timestamp: number) => ({
    method: 'GET' as const,
    path: '/api/v1/futures/balance',
    query: { recvWindow, timestamp },
    signed: true,
  }),
  /** Signed — open positions (all symbols). */
  positions: (recvWindow: number, timestamp: number) => ({
    method: 'GET' as const,
    path: '/api/v1/futures/positions',
    query: { recvWindow, timestamp },
    signed: true,
  }),
  /**
   * Signed — open conditional orders (TP/SL read-back).
   * VERIFIED LIVE (mission-3 probe) + official docs (api-docs.toobit.com,
   * "Query current open orders"): `type` defaults to LIMIT which HIDES TP/SL
   * rows — `type=STOP_PROFIT_LOSS` is mandatory. Response rows carry
   * `stopPrice` (trigger) + `orderType` (STOP_LONG_PROFIT |
   * STOP_LONG_LOSS | STOP_SHORT_PROFIT | STOP_SHORT_LOSS) + status ORDER_NEW.
   */
  stopOrders: (params: { recvWindow: number; timestamp: number }) => ({
    method: 'GET' as const,
    path: '/api/v1/futures/openOrders',
    query: { type: 'STOP_PROFIT_LOSS', recvWindow: params.recvWindow, timestamp: params.timestamp },
    signed: true,
  }),
  /**
   * Signed — closed positions history (all symbols). Live-verified:
   * `limit` is honored (docs max 1000, LIVE CAP 200 — probe `?limit=200`
   * returned 200 rows); `pageSize` is silently ignored. Cursor = row `id`.
   */
  historyPositions: (params: { limit?: number; recvWindow: number; timestamp: number }) => ({
    method: 'GET' as const,
    path: '/api/v1/futures/historyPositions',
    query: (params.limit ? { limit: params.limit, recvWindow: params.recvWindow, timestamp: params.timestamp } : { recvWindow: params.recvWindow, timestamp: params.timestamp }) as Record<string, string | number>,
    signed: true,
  }),
  /**
   * Signed — user trade fills.
   * NOTE: the reference builds this query MANUALLY in unsorted order
   * (symbol, limit, recvWindow, timestamp) — signature must cover that
   * exact string. Kept verbatim.
   */
  userTrades: (params: { symbol: string; limit: number; recvWindow: number; timestamp: number }) => ({
    method: 'GET' as const,
    path: '/api/v1/futures/userTrades',
    manualQuery: `symbol=${params.symbol}&limit=${params.limit}&recvWindow=${params.recvWindow}&timestamp=${params.timestamp}`,
    signed: true,
  }),
  /** Signed — set leverage for a symbol. */
  leverage: (params: { symbol: string; leverage: number; recvWindow: number; timestamp: number }) => ({
    method: 'POST' as const,
    path: '/api/v1/futures/leverage',
    body: params,
    signed: true,
  }),
  /**
   * Signed — place order. Toobit market-via-limit pattern preserved:
   * type LIMIT + priceType MARKET with NO price field.
   */
  order: (params: {
    symbol: string
    side: 'BUY_OPEN' | 'SELL_OPEN' | 'SELL_CLOSE' | 'BUY_CLOSE'
    quantity: number
    clientOrderId: string
    recvWindow: number
    timestamp: number
  }) => ({
    method: 'POST' as const,
    path: '/api/v1/futures/order',
    body: {
      type: 'LIMIT',
      priceType: 'MARKET',
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      newClientOrderId: params.clientOrderId,
      recvWindow: params.recvWindow,
      timestamp: params.timestamp,
    },
    signed: true,
  }),
  /** Signed — set TP/SL on an open position. */
  tradingStop: (params: {
    symbol: string
    side: 'LONG' | 'SHORT'
    takeProfit?: number
    stopLoss?: number
    recvWindow: number
    timestamp: number
  }) => {
    const body: Record<string, string | number> = {
      symbol: params.symbol,
      side: params.side,
      recvWindow: params.recvWindow,
      timestamp: params.timestamp,
    }
    if (params.takeProfit != null) {
      body.takeProfit = params.takeProfit
      body.tpTriggerBy = 'CONTRACT_PRICE'
    }
    if (params.stopLoss != null) {
      body.stopLoss = params.stopLoss
      body.slTriggerBy = 'CONTRACT_PRICE'
    }
    return { method: 'POST' as const, path: '/api/v1/futures/position/trading-stop', body, signed: true }
  },
} as const

/** {BTC} → BTC-SWAP-USDT */
export function fullSymbol(symbol: string): string {
  const s = symbol.toUpperCase().replace(/-SWAP-USDT$/, '')
  return `${s}-SWAP-USDT`
}

/**
 * Per-contract size for USDT-M perpetuals (reference hardcode — kept as
 * an explicit constant; in production this should be validated against
 * /api/v1/market/instrument or similar contract-info endpoint).
 */
export const CONTRACT_SIZE = 0.11

export function computeOrderQty(usdtMargin: number, leverage: number, price: number): number {
  const notional = usdtMargin * leverage
  return Math.ceil(notional / (price * CONTRACT_SIZE))
}
