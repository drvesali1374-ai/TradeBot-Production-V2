/**
 * Demo exchange state — test-environment simulation (instruction §9
 * "حالت اول: توسعه سریع — داده آزمایشی").
 *
 * When no Toobit API keys are configured, account/order operations run
 * against this persisted simulated state while MARKET DATA stays REAL.
 * Simulated TP/SL auto-close uses the real live price each time
 * positions are fetched, so the full cycle → order → TP/SL → history
 * lifecycle can be exercised end-to-end without touching real funds.
 */
import type { BalanceInfo, OpenPosition, ClosedPosition } from '@/core/types'
import { getStorage, STORAGE_KEYS } from '@/server/storage'
import { fullSymbol } from './endpoints'

export interface DemoPosition {
  id: string
  symbol: string // short name, e.g. BTC
  side: 'LONG' | 'SHORT'
  qty: number
  margin: number
  leverage: number
  entryPrice: number
  takeProfit: number | null
  stopLoss: number | null
  openedAt: number
  orderId: string
}

export interface DemoClosedPosition extends DemoPosition {
  closePrice: number
  closedAt: number
  realizedPnl: number
  realizedPnlRate: number
  closeReason: 'TP' | 'SL' | 'MANUAL'
}

export interface DemoState {
  balance: number // total USDT
  realizedPnl: number
  positions: DemoPosition[]
  closed: DemoClosedPosition[]
  fills: {
    id: string
    symbol: string
    side: 'LONG' | 'SHORT'
    qty: number
    price: number
    time: number
    clientOrderId: string
  }[]
  seq: number
}

export const DEMO_START_BALANCE = 10_000

function emptyState(): DemoState {
  return { balance: DEMO_START_BALANCE, realizedPnl: 0, positions: [], closed: [], fills: [], seq: 1 }
}

export class DemoEngine {
  async load(): Promise<DemoState> {
    const st = await getStorage().get<DemoState>(STORAGE_KEYS.demoState)
    return st ?? emptyState()
  }

  private async save(state: DemoState): Promise<void> {
    await getStorage().put(STORAGE_KEYS.demoState, state)
  }

  /** Live prices per full symbol (injected by the client before ops). */
  private priceCache = new Map<string, number>()
  /** When each full-symbol price was last refreshed (10s TTL). */
  private priceCachedAt = new Map<string, number>()

  setPrice(symbol: string, price: number): void {
    const full = fullSymbol(symbol)
    this.priceCache.set(full, price)
    this.priceCachedAt.set(full, Date.now())
  }

  getPrice(symbol: string): number | null {
    return this.priceCache.get(fullSymbol(symbol)) ?? null
  }

  async balance(): Promise<BalanceInfo> {
    const st = await this.load()
    // realize unrealized with live prices
    let unrealized = 0
    let usedMargin = 0
    for (const p of st.positions) {
      const price = this.getPrice(p.symbol) ?? p.entryPrice
      unrealized += unrealizedPnl(p, price)
      usedMargin += p.margin
    }
    const total = st.balance + unrealized
    return {
      asset: 'USDT',
      total: round4(total),
      available: round4(st.balance - usedMargin),
      free: round4(st.balance - usedMargin),
      positionMargin: round4(usedMargin),
      orderMargin: 0,
      unrealizedPnL: round4(unrealized),
      fetchedAt: Date.now(),
    }
  }

  /** Positions with live PnL; TP/SL auto-close applied first. */
  async positions(): Promise<OpenPosition[]> {
    const st0 = await this.load()
    // Refresh live prices for held symbols (public endpoint) so UI fetches
    // show fresh PnL and TP/SL auto-close uses current prices even when
    // the caller didn't tick prices first.
    for (const p of st0.positions) {
      const full = fullSymbol(p.symbol)
      const cachedAt = this.priceCachedAt.get(full) ?? 0
      if (Date.now() - cachedAt > 10_000) {
        try {
          const res = await fetch(
            `https://api.toobit.com/quote/v1/ticker/price?symbol=${full}`,
            { cache: 'no-store' }
          )
          if (res.ok) {
            const data = (await res.json()) as unknown
            const price = Array.isArray(data) ? Number(data[0]?.p) : Number((data as { p?: string }).p)
            if (Number.isFinite(price) && price > 0) {
              this.setPrice(p.symbol, price)
              this.priceCachedAt.set(full, Date.now())
            }
          }
        } catch {
          /* price stays at entry fallback */
        }
      }
    }
    let st = st0
    st = await this.applyTpslAutoClose(st)
    const out: OpenPosition[] = []
    for (const p of st.positions) {
      const price = this.getPrice(p.symbol) ?? p.entryPrice
      const pnl = unrealizedPnl(p, price)
      out.push({
        symbol: fullSymbol(p.symbol),
        side: p.side,
        qty: p.qty,
        available: p.qty,
        margin: p.margin,
        leverage: p.leverage,
        entryPrice: p.entryPrice,
        markPrice: price,
        unrealizedPnL: round4(pnl),
        profitRate: p.margin > 0 ? round4((pnl / p.margin) * 100) : 0,
        takeProfit: p.takeProfit,
        stopLoss: p.stopLoss,
      })
    }
    return out
  }

  private async applyTpslAutoClose(st: DemoState): Promise<DemoState> {
    let changed = false
    const remaining: DemoPosition[] = []
    for (const p of st.positions) {
      const price = this.getPrice(p.symbol) ?? p.entryPrice
      const hitTp = p.side === 'LONG' ? p.takeProfit != null && price >= p.takeProfit : p.takeProfit != null && price <= p.takeProfit
      const hitSl = p.side === 'LONG' ? p.stopLoss != null && price <= p.stopLoss : p.stopLoss != null && price >= p.stopLoss
      if (hitTp || hitSl) {
        const closePrice = hitTp ? (p.takeProfit as number) : (p.stopLoss as number)
        st.closed.push(closeDemo(p, closePrice, hitTp ? 'TP' : 'SL', Date.now()))
        st.balance += unrealizedPnl(p, closePrice)
        st.realizedPnl += unrealizedPnl(p, closePrice)
        changed = true
      } else {
        remaining.push(p)
      }
    }
    if (changed) {
      st.positions = remaining
      await this.save(st)
    }
    return st
  }

  async historyPositions(): Promise<ClosedPosition[]> {
    const st = await this.load()
    return [...st.closed]
      .sort((a, b) => b.closedAt - a.closedAt)
      .map((c) => ({
        id: c.id,
        symbol: fullSymbol(c.symbol),
        side: c.side,
        qty: c.qty,
        entryPrice: c.entryPrice,
        closePrice: c.closePrice,
        closeTime: c.closedAt,
        realizedPnl: round4(c.realizedPnl),
        realizedPnlRate: round4(c.realizedPnlRate),
        leverage: c.leverage,
        closeReason: c.closeReason,
      }))
  }

  async userTrades(symbol: string): Promise<DemoState['fills']> {
    const st = await this.load()
    return st.fills.filter((f) => fullSymbol(f.symbol) === fullSymbol(symbol))
  }

  async openPosition(params: {
    symbol: string
    side: 'LONG' | 'SHORT'
    qty: number
    margin: number
    leverage: number
    price: number
    tp: number | null
    sl: number | null
    clientOrderId: string
  }): Promise<{ orderId: string }> {
    const st = await this.load()
    const orderId = `demo-${st.seq++}`
    st.positions.push({
      id: orderId,
      symbol: params.symbol.toUpperCase(),
      side: params.side,
      qty: params.qty,
      margin: params.margin,
      leverage: params.leverage,
      entryPrice: params.price,
      takeProfit: params.tp,
      stopLoss: params.sl,
      openedAt: Date.now(),
      orderId: params.clientOrderId,
    })
    st.fills.push({
      id: `fill-${orderId}`,
      symbol: params.symbol.toUpperCase(),
      side: params.side,
      qty: params.qty,
      price: params.price,
      time: Date.now(),
      clientOrderId: params.clientOrderId,
    })
    await this.save(st)
    return { orderId }
  }

  async closePosition(params: { symbol: string; side: 'LONG' | 'SHORT' }): Promise<{ closed: number }> {
    let st = await this.load()
    st = await this.applyTpslAutoClose(st)
    const price = this.getPrice(params.symbol)
    let closed = 0
    const remaining: DemoPosition[] = []
    for (const p of st.positions) {
      if (p.symbol.toUpperCase() === params.symbol.toUpperCase() && p.side === params.side) {
        const closePrice = price ?? p.entryPrice
        st.closed.push(closeDemo(p, closePrice, 'MANUAL', Date.now()))
        const pnl = unrealizedPnl(p, closePrice)
        st.balance += pnl
        st.realizedPnl += pnl
        closed++
      } else {
        remaining.push(p)
      }
    }
    st.positions = remaining
    await this.save(st)
    return { closed }
  }

  async setTradingStops(params: {
    symbol: string
    side: 'LONG' | 'SHORT'
    takeProfit?: number | null
    stopLoss?: number | null
  }): Promise<boolean> {
    const st = await this.load()
    let found = false
    for (const p of st.positions) {
      if (p.symbol.toUpperCase() === params.symbol.toUpperCase() && p.side === params.side) {
        p.takeProfit = params.takeProfit ?? null
        p.stopLoss = params.stopLoss ?? null
        found = true
      }
    }
    if (found) await this.save(st)
    return found
  }

  async stats(): Promise<{ total: number; winning: number; losing: number; totalPnl: number }> {
    const st = await this.load()
    const total = st.closed.length
    const winning = st.closed.filter((c) => c.realizedPnl > 0).length
    const losing = st.closed.filter((c) => c.realizedPnl < 0).length
    const totalPnl = st.closed.reduce((s, c) => s + c.realizedPnl, 0)
    return { total, winning, losing, totalPnl: round4(totalPnl) }
  }
}

function unrealizedPnl(p: DemoPosition, price: number): number {
  const per = p.side === 'LONG' ? price - p.entryPrice : p.entryPrice - price
  return per * p.qty * 0.11 // contract size — mirrors live qty semantics
}

function closeDemo(p: DemoPosition, closePrice: number, reason: 'TP' | 'SL' | 'MANUAL', at: number): DemoClosedPosition {
  const pnl = unrealizedPnl(p, closePrice)
  return {
    ...p,
    closePrice,
    closedAt: at,
    realizedPnl: round4(pnl),
    realizedPnlRate: p.margin > 0 ? round4((pnl / p.margin) * 100) : 0,
    closeReason: reason,
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** Singleton demo engine. */
export const demoEngine = new DemoEngine()
