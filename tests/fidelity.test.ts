/**
 * COMPARATIVE FIDELITY TESTS (mission §6) — V2 core vs the audited
 * TradeBot-Production reference semantics. The "twin" implementations
 * below are written INDEPENDENTLY from the reference audit spec
 * (public/js/shared/signal-utils.js + automation-manager.js) — never
 * imported from V2 source — so equality is a real cross-check.
 *
 * Covered (mission §6.4): Long/Short/no-signal fixtures, expiry,
 * risk-control rejection incl. prefix-candle semantics, existing
 * position gate, TP/SL math, PnL rate scale, order-qty contract.
 * Run: bun run tests/fidelity.test.ts
 */
import { calculateRSI, calculateATR } from '../src/core/indicators'
import { computeTPSL } from '../src/core/signals/generate'
import { resolveSignalStatus } from '../src/core/signals/status'
import { isSignalExpired, DEFAULT_AUTOMATION_SETTINGS } from '../src/core/settings'
import { evaluateRiskControls, calculateNewMargin } from '../src/core/risk/controls'
import { analyzeSymbol } from '../src/core/signals/generate'
import { normalizePosition } from '../src/server/exchanges/toobit/client'
import { computeOrderQty } from '../src/server/exchanges/toobit/endpoints'
import type { Signal, Candle, ClosedPosition } from '../src/core/types'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) pass++
  else {
    fail++
    console.error(`✗ ${label}`)
  }
}
const S = DEFAULT_AUTOMATION_SETTINGS
const H = 3_600_000
/** Tehran midnight base for fixtures. */
const T0 = -12_600_000 // exact Tehran midnight (UTC−3:30)

/* ---------------------------------------------------------------- */
/* Twin implementations — written from the REFERENCE audit spec      */
/* ---------------------------------------------------------------- */

/** Reference RSI (signal-utils.js:13-44) — off-by-one, length N−1. */
function twinRefRSI(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = []
  let avgGain = 0
  let avgLoss = 0
  const usable = Math.min(period, closes.length - 1)
  for (let i = 1; i <= usable; i++) {
    avgGain += Math.max(closes[i] - closes[i - 1], 0)
    avgLoss += Math.max(closes[i - 1] - closes[i], 0)
  }
  if (closes.length <= period) return closes.map(() => null)
  avgGain /= period
  avgLoss /= period
  for (let i = 1; i < closes.length; i++) {
    if (i > period) {
      const ch = closes[i] - closes[i - 1]
      avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period
      avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    out.push(avgGain === 0 && avgLoss === 0 ? null : 100 - 100 / (1 + rs))
  }
  return out // out[k] = RSI of candle k+1 (reference indexing bug)
}

/** Reference ATR (signal-utils.js:52-74): seed first TR, Wilder RMA. */
function twinATR(candles: { high: number; low: number; close: number }[], period: number): number[] {
  const n = candles.length
  const atr = new Array(n).fill(0)
  if (!n) return atr
  const tr: number[] = new Array(n)
  tr[0] = candles[0].high - candles[0].low
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
  }
  atr[0] = tr[0]
  for (let i = 1; i < n; i++) atr[i] = ((period - 1) * atr[i - 1] + tr[i]) / period
  return atr
}

/** Reference TP/SL (automation-manager.js:954-995). */
function twinTPSL(side: 'Long' | 'Short', close: number, atr: number, s: typeof S) {
  if (side === 'Long') {
    return {
      tp: s.longFixedTp != null ? close + (close * s.longFixedTp) / 100 : close + atr * s.tpLongMult,
      sl: s.longFixedSl != null ? close - (close * s.longFixedSl) / 100 : close - atr * s.slLongMult,
    }
  }
  return {
    tp: s.shortFixedTp != null ? close - (close * s.shortFixedTp) / 100 : close - atr * s.tpShortMult,
    sl: s.shortFixedSl != null ? close + (close * s.shortFixedSl) / 100 : close + atr * s.slShortMult,
  }
}

/* ---------------------------------------------------------------- */
/* Candle fixture builders                                          */
/* ---------------------------------------------------------------- */

const candle = (openTime: number, o: number, h: number, l: number, c: number, volume = 100): Candle => ({
  openTime,
  closeTime: openTime + H,
  open: o,
  high: h,
  low: l,
  close: c,
  volume,
})

/**
 * 50-candle fixtures: avgVol SMA(50) is null before index 49, so the
 * recovery candle sits at index 49 — the FIRST index the volume filter
 * can pass (identical constraint exists in the reference).
 * Day layout: day0 = 24 declining candles, day1 = 24 flat candles,
 * day2 = break + recovery candles (indices 48/49).
 */
function longFixture(): Candle[] {
  const out: Candle[] = []
  // Tehran day 0 + day 1: continuous decline 110 -> 89.84 (0.42/candle)
  for (let i = 0; i < 48; i++) {
    const open = 110 - i * 0.42
    const close = open - 0.42
    out.push(candle(T0 + i * H, open, open + 0.02, close - 0.02, close))
  }
  // day-3 candle 48: deep wick below day-1 low (89.82) − 0.2×ATR -> break
  out.push(candle(T0 + 48 * H, 89.84, 89.9, 86.5, 87.0, 200))
  // day-3 candle 49: close back inside prior-day range -> recovery.
  // High (90.1) stays far below day-1 high (99.94) so no opposite break
  // replaces the pending Long state before the recovery check.
  out.push(candle(T0 + 49 * H, 87.5, 90.1, 87.3, 90.0, 300))
  return out
}

/** Mirrored rising fixture → Short signal (same 3-day layout). */
function shortFixture(): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < 48; i++) {
    const open = 100 + i * 0.42
    const close = open + 0.42
    out.push(candle(T0 + i * H, open, close + 0.02, open - 0.02, close))
  }
  out.push(candle(T0 + 48 * H, 120.16, 123.3, 120.1, 123.04, 200))
  // close 120.0 < day-1 high 120.18 -> Short recovery; low 119.8 stays
  // far above day-1 low (110.06) -> no opposite-break replacement.
  out.push(candle(T0 + 49 * H, 123.0, 123.2, 119.8, 120.0, 300))
  return out
}

const NOW = T0 + 50 * H + 1 // everything closed

/* ---------------------------------------------------------------- */
/* 1. Indicator twins                                               */
/* ---------------------------------------------------------------- */
{
  const candles = longFixture()
  const closes = candles.map((c) => c.close)
  const v2Rsi = calculateRSI(candles, S.rsiPeriod)
  const refRsi = twinRefRSI(closes, S.rsiPeriod)
  // formula identity: V2 rsi[i] (aligned) === reference rsi[i−1] (shifted)
  let identical = true
  for (let i = S.rsiPeriod + 1; i < closes.length; i++) {
    const a = v2Rsi[i]
    const b = refRsi[i - 1]
    if (a == null || b == null || Math.abs(a - b) > 1e-9) identical = false
  }
  assert(identical, 'RSI: V2 values ≡ reference values (documented 1-candle index shift — repaint fix, §6.2.6)')
  const v2Atr = calculateATR(candles, S.atrPeriod)
  const refAtr = twinATR(candles, S.atrPeriod)
  let atrSame = true
  for (let i = 0; i < candles.length; i++) if (Math.abs((v2Atr[i] ?? 0) - refAtr[i]) > 1e-9) atrSame = false
  assert(atrSame, 'ATR: exact equality with reference (seed-first-TR + Wilder RMA)')
}

/* ---------------------------------------------------------------- */
/* 2. End-to-end signal fixtures (Long / Short / none)              */
/* ---------------------------------------------------------------- */
{
  const a = analyzeSymbol({ symbol: 'BTC', candles: longFixture(), settings: S, now: NOW })
  assert(a.signals.length === 1, `Long fixture → exactly 1 signal (got ${a.signals.length})`)
  const sig = a.signals[0]
  assert(sig.side === 'Long', 'fixture signal is Long')
  const recovery = longFixture()[49]
  assert(sig.price === recovery.close, 'entry price = recovery candle close (reference rule)')
  assert(sig.candleOpenTime === recovery.openTime, 'signal time = recovery candle openTime')
  const atrAt = twinATR(longFixture(), S.atrPeriod)[49]
  const expected = twinTPSL('Long', recovery.close, atrAt, S)
  assert(Math.abs(sig.tp - expected.tp) < 1e-6, `Long TP = close + ATR×${S.tpLongMult} (twin math)`)
  assert(Math.abs(sig.sl - expected.sl) < 1e-6, `Long SL = close − ATR×${S.slLongMult} (twin math)`)
}
{
  const a = analyzeSymbol({ symbol: 'ETH', candles: shortFixture(), settings: S, now: NOW })
  assert(a.signals.length === 1, `Short fixture → exactly 1 signal (got ${a.signals.length})`)
  const sig = a.signals[0]
  assert(sig.side === 'Short', 'fixture signal is Short')
  const recovery = shortFixture()[49]
  const atrAt = twinATR(shortFixture(), S.atrPeriod)[49]
  // default quirk: shortFixedSl = 6 → %-based SL (reference init-settings)
  const expected = twinTPSL('Short', recovery.close, atrAt, S)
  assert(Math.abs(sig.tp - expected.tp) < 1e-6, `Short TP = close − ATR×${S.tpShortMult}`)
  assert(Math.abs(sig.sl - expected.sl) < 1e-6, 'Short SL = close + close×6٪ (shortFixedSl default quirk preserved)')
}
{
  const flat = Array.from({ length: 30 }, (_, i) => candle(T0 + i * H, 100, 100.1, 99.9, 100))
  const a = analyzeSymbol({ symbol: 'XRP', candles: flat, settings: S, now: T0 + 30 * H + 1 })
  assert(a.signals.length === 0, 'flat fixture → no signal')
}

/* ---------------------------------------------------------------- */
/* 3. Expiration — measured from candle OPEN time (reference)       */
/* ---------------------------------------------------------------- */
{
  const sig: Signal = {
    id: 'x', symbol: 'BTC', side: 'Long', candleOpenTime: 1_000, candleCloseTime: 1_000 + H,
    signalConfirmedAt: 1_000 + H, price: 1, tp: 2, sl: 0.5,
  }
  // 6h after OPEN → expired; 6h after CLOSE would not be yet
  assert(isSignalExpired(sig, S, 1_000 + 6 * H + 1), 'expired at 6h+ε after candle OPEN')
  assert(!isSignalExpired(sig, S, 1_000 + 6 * H - 1), 'not expired at 6h−ε')
}

/* ---------------------------------------------------------------- */
/* 4. Signal status gate (existing position / dedup, ref §3.6)     */
/* ---------------------------------------------------------------- */
{
  const base: Signal = {
    id: 's1', symbol: 'BTC', side: 'Long', candleOpenTime: 10_000, candleCloseTime: 10_000 + H,
    signalConfirmedAt: 10_000 + H, price: 100, tp: 110, sl: 95,
  }
  const older: Signal = { ...base, id: 's0', candleOpenTime: 10_000 - 5 * H, candleCloseTime: 10_000 - 4 * H, signalConfirmedAt: 10_000 - 4 * H }
  // fill DURING the signal candle window counts as OPENED (open-time window)
  const during = resolveSignalStatus([base], [{ time: 10_500, side: 'LONG', symbol: 'BTC-SWAP-USDT' }], 6)
  assert(during.get('s1') === 'OPENED', 'fill inside candle → OPENED (openTime window, ref §3.6)')
  // full-symbol vs short-symbol normalization
  const norm = resolveSignalStatus([base], [{ time: 12_000, side: 'LONG', symbol: 'BTC-SWAP-USDT' }], 6)
  assert(norm.get('s1') === 'OPENED', 'full exchange symbol normalized against short signal symbol')
  // opposite-direction fill does NOT mark opened
  const opp = resolveSignalStatus([base], [{ time: 12_000, side: 'SHORT', symbol: 'BTC-SWAP-USDT' }], 6, 12_000)
  assert(opp.get('s1') === 'PENDING', 'opposite-direction fill ignored')
  // older signal not opened even when a later fill exists (window ends at next signal)
  const multi = resolveSignalStatus([older, base], [{ time: 5_000, side: 'LONG', symbol: 'BTC-SWAP-USDT' }], 6, 12_000)
  assert(multi.get('s0') === 'OPENED', 'fill within [older, next) marks the OLDER one OPENED')
  assert(multi.get('s1') === 'PENDING', 'latest unmatched → PENDING')
  // expired latest
  const exp = resolveSignalStatus([base], [], 6, 10_000 + 7 * H)
  assert(exp.get('s1') === 'EXPIRED', 'latest beyond 6h → EXPIRED')
}

/* ---------------------------------------------------------------- */
/* 5. Risk controls — prefix candle semantics + entry price source */
/* ---------------------------------------------------------------- */
{
  const sig: Signal = {
    id: 'r1', symbol: 'BTC', side: 'Long', candleOpenTime: 0, candleCloseTime: H,
    signalConfirmedAt: H, price: 100, tp: 120, sl: 90,
  }
  const ctx = {
    balance: { total: 1000, free: 1000 },
    newMargin: 50,
    price: 100,
    symbolPositions: [],
    lastOpenPrice: null,
    postSignalCandles: [],
  }
  // a) prefix: [red, green, green] required=2 → REJECT (first candle red)
  const a = evaluateRiskControls(sig, { ...ctx, postSignalCandles: [{ open: 10, close: 9 }, { open: 9, close: 10 }, { open: 10, close: 11 }] }, { ...S, minSameDirectionCandles: 2 })
  assert(a.rejection?.control === 'SAME_DIRECTION_CANDLES', 'prefix semantics: first-2 must be same-direction (red first ⇒ reject)')
  // b) prefix: [green, green, red] required=2 → PASS (reference checks the FIRST N)
  const b = evaluateRiskControls(sig, { ...ctx, postSignalCandles: [{ open: 9, close: 10 }, { open: 10, close: 11 }, { open: 11, close: 10 }] }, { ...S, minSameDirectionCandles: 2 })
  assert(b.passed, 'prefix semantics: first-2 same-direction ⇒ pass (trailing red irrelevant)')
  // c) insufficient candles → reject (includes forming candle in count)
  const c = evaluateRiskControls(sig, { ...ctx, postSignalCandles: [{ open: 9, close: 10 }] }, { ...S, minSameDirectionCandles: 2 })
  assert(c.rejection?.control === 'SAME_DIRECTION_CANDLES', 'insufficient post-signal candles ⇒ reject')
  // d) safe asset: free 300 − margin 50 = 250 < 500 (50% of 1000) → reject
  const d = evaluateRiskControls(sig, { ...ctx, balance: { total: 1000, free: 300 } }, S)
  assert(d.rejection?.control === 'SAFE_ASSET', 'safe-asset rejection math')
  // e) price distance uses lastOpenPrice from trade history (not position avg)
  const positions = [{ symbol: 'BTC-SWAP-USDT', side: 'LONG', qty: 1, available: 1, margin: 10, leverage: 4, entryPrice: 90, markPrice: 100, unrealizedPnL: 1, profitRate: 1 }]
  const e = evaluateRiskControls(sig, { ...ctx, balance: { total: 1000, free: 900 }, symbolPositions: positions, lastOpenPrice: 100.1 }, S)
  const eDist = e.results.find((r) => r.control === 'PRICE_DISTANCE')
  assert(eDist?.passed === false, 'distance from lastOpenPrice 100.1 → 0.0999٪ < 0.5٪ ⇒ reject')
  const f = evaluateRiskControls(sig, { ...ctx, balance: { total: 1000, free: 900 }, symbolPositions: positions, lastOpenPrice: 101 }, S)
  const fDist = f.results.find((r) => r.control === 'PRICE_DISTANCE')
  assert(fDist?.passed === true, 'distance from lastOpenPrice 101 → 0.99٪ ≥ 0.5٪ ⇒ pass')
  // f) no lastOpenPrice → control skipped (reference null semantics)
  const g = evaluateRiskControls(sig, { ...ctx, balance: { total: 1000, free: 900 }, symbolPositions: positions, lastOpenPrice: null }, S)
  assert(g.passed, 'no OPEN fill in history ⇒ price-distance skipped (ref behavior)')
  // h) positive margin
  const h = evaluateRiskControls(sig, { ...ctx, newMargin: 0 }, S)
  assert(h.rejection?.control === 'POSITIVE_MARGIN', 'zero margin rejected')
  // i) margin formula
  assert(calculateNewMargin(1000, 5) === 50, 'margin = total × 5٪ rounded to 2dp')
}

/* ---------------------------------------------------------------- */
/* 6. PnL scale contracts (live-verified)                           */
/* ---------------------------------------------------------------- */
{
  const raw = { symbol: 'XRP-SWAP-USDT', side: 'SHORT', position: '65', available: '65', leverage: '4', avgPrice: '1.335', markPrice: '1.3483', margin: '2.1569', unrealizedPnL: '-0.0838', profitRate: '-0.0386' }
  const p = normalizePosition(raw)
  assert(Math.abs((p.profitRate ?? 0) - -3.86) < 1e-9, 'open-position profitRate: FRACTION ×100 (live value −0.0386 → −3.86٪)')
  assert(p.unrealizedPnL === -0.0838, 'unrealizedPnL passed through (USDT)')
  const closed: ClosedPosition = { id: '1', symbol: 'XRP-SWAP-USDT', side: 'LONG', qty: 13.8, closePrice: 1.335, closeTime: 1, realizedPnl: -0.10639439, realizedPnlRate: -2.300216, leverage: 4 }
  void closed // rate conversion happens at normalizeHistoryPosition (covered by tpsl/pnl suites); the raw-live scale fact:
}

/* ---------------------------------------------------------------- */
/* 7. Order-quantity contract (reference create-position)            */
/* ---------------------------------------------------------------- */
{
  // qty = ceil(margin × leverage / (price × 0.11)) — integer contracts
  assert(computeOrderQty(50, 4, 100) === Math.ceil(200 / 11), 'qty = ceil(margin×lev/(price×0.11)) — contracts')
  assert(computeOrderQty(10, 1, 100) === 1, 'small order rounds UP to 1 contract')
}

console.log(`\nFidelity: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
