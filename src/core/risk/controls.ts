/**
 * Risk controls — the 6 controls of the reference (audit-1 §A.7),
 * single implementation used by the cycle engine only (never in the UI).
 *
 *  1. Safe asset:      free − newMargin ≥ total × safeAssetPercent%
 *  2. Price distance:  ((lastEntry − price)/lastEntry)×100 ≥ min%  (only
 *                      when the symbol already has an open position)
 *  3. Max margin/sym:  existing + new ≤ total × maxMarginPerSymbol%
 *                      (only when the symbol already has an open position)
 *  4. Positive margin: newMargin > 0
 *  5. Same-direction candles after the signal (closed candles only)
 *  6. Signal expiration (checked by caller via isSignalExpired)
 */
import type { Signal, OpenPosition } from '../types'
import type { AutomationSettings } from '../settings'

export type RiskControlId =
  | 'SAFE_ASSET'
  | 'PRICE_DISTANCE'
  | 'MAX_MARGIN'
  | 'POSITIVE_MARGIN'
  | 'SAME_DIRECTION_CANDLES'

export interface RiskControlResult {
  passed: boolean
  control: RiskControlId
  /** Persian explanation incl. the math breakdown (for Bale message) */
  message: string
  math: string
}

export interface RiskContext {
  balance: { total: number; free: number }
  newMargin: number
  price: number
  /** Existing same-symbol positions (direction-agnostic margin sum) */
  symbolPositions: OpenPosition[]
  /** Candles AFTER the signal candle (closed only) */
  postSignalCandles: { open: number; close: number }[]
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function calculateNewMargin(totalAssets: number, entryMarginPercent: number): number {
  return round2((totalAssets * entryMarginPercent) / 100)
}

export function getSymbolMargin(positions: OpenPosition[], symbol: string): number {
  return positions
    .filter((p) => p.symbol.toUpperCase().startsWith(symbol.toUpperCase()))
    .reduce((sum, p) => sum + (p.margin || 0), 0)
}

function fa(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function evaluateRiskControls(
  signal: Signal,
  ctx: RiskContext,
  settings: AutomationSettings
): { passed: boolean; results: RiskControlResult[]; rejection?: RiskControlResult } {
  const results: RiskControlResult[] = []
  const isLong = signal.side === 'Long'
  const symbolPositions = ctx.symbolPositions

  // --- 1. Safe asset ---
  const safeThreshold = (ctx.balance.total * settings.safeAssetPercent) / 100
  const remaining = ctx.balance.free - ctx.newMargin
  const safeAssetPassed = remaining >= safeThreshold
  results.push({
    control: 'SAFE_ASSET',
    passed: safeAssetPassed,
    message: safeAssetPassed
      ? 'کنترل دارایی امن تأیید شد.'
      : `کنترل دارایی امن رد شد — باقی‌مانده آزاد ${fa(remaining)} کمتر از حد مجاز ${fa(safeThreshold)} است.`,
    math: `موجودی آزاد: ${fa(ctx.balance.free)} − مارجین جدید: ${fa(ctx.newMargin)} = ${fa(remaining)} | حد مجاز: ${fa(ctx.balance.total)} × ${settings.safeAssetPercent}٪ = ${fa(safeThreshold)}`,
  })

  // --- 2. Price distance (only when symbol has an open position) ---
  if (symbolPositions.length > 0) {
    const minDist = isLong ? settings.minPriceDistancePercentLong : settings.minPriceDistancePercentShort
    // Last entry = highest entry among same-side positions (reference used last entry)
    const sameSide = symbolPositions.filter((p) => p.side === (isLong ? 'LONG' : 'SHORT'))
    if (sameSide.length > 0) {
      const knownEntry = sameSide.filter((p) => p.entryPrice != null).at(-1)?.entryPrice ?? null
      if (knownEntry == null) {
        // Exchange did not provide an entry price — indeterminable, NEVER
        // fabricated as zero (mission §1.2.6). Conservative: block entry.
        results.push({
          control: 'PRICE_DISTANCE',
          passed: false,
          message: 'کنترل فاصله قیمت قابل ارزیابی نیست — قیمت ورود پوزیشن باز از صرافی دریافت نشد.',
          math: 'قیمت ورود قبلی: نامشخص',
        })
      } else {
        const distancePct = isLong
          ? ((knownEntry - ctx.price) / knownEntry) * 100
          : ((ctx.price - knownEntry) / knownEntry) * 100
        const distPassed = distancePct >= minDist
        results.push({
          control: 'PRICE_DISTANCE',
          passed: distPassed,
          message: distPassed
            ? `کنترل فاصله قیمت تأیید شد (${fa(distancePct)}٪ ≥ ${fa(minDist)}٪).`
            : `کنترل فاصله قیمت رد شد — فاصله ${fa(distancePct)}٪ کمتر از حد مجاز ${fa(minDist)}٪ است.`,
          math: isLong
            ? `((قیمت ورود قبلی ${fa(knownEntry)} − قیمت فعلی ${fa(ctx.price)}) ÷ ${fa(knownEntry)}) × ۱۰۰ = ${fa(distancePct)}٪`
            : `((قیمت فعلی ${fa(ctx.price)} − قیمت ورود قبلی ${fa(knownEntry)}) ÷ ${fa(knownEntry)}) × ۱۰۰ = ${fa(distancePct)}٪`,
        })
      }
    }
  }

  // --- 3. Max margin per symbol (only when symbol has an open position) ---
  if (symbolPositions.length > 0) {
    const existing = getSymbolMargin(symbolPositions, signal.symbol)
    const maxAllowed = (ctx.balance.total * settings.maxMarginPerSymbolPercent) / 100
    const marginPassed = existing + ctx.newMargin <= maxAllowed
    results.push({
      control: 'MAX_MARGIN',
      passed: marginPassed,
      message: marginPassed
        ? 'کنترل سقف مارجین نماد تأیید شد.'
        : `کنترل سقف مارجین رد شد — مجموع مارجین نماد ${fa(existing + ctx.newMargin)} بیشتر از سقف ${fa(maxAllowed)} است.`,
      math: `مارجین موجود نماد: ${fa(existing)} + مارجین جدید: ${fa(ctx.newMargin)} = ${fa(existing + ctx.newMargin)} | سقف: ${fa(ctx.balance.total)} × ${settings.maxMarginPerSymbolPercent}٪ = ${fa(maxAllowed)}`,
    })
  }

  // --- 4. Positive margin ---
  const positivePassed = Math.max(ctx.newMargin, 0) > 0
  results.push({
    control: 'POSITIVE_MARGIN',
    passed: positivePassed,
    message: positivePassed
      ? 'مارجین محاسبه‌شده مثبت است.'
      : 'کنترل مارجین مثبت رد شد — مارجین محاسبه‌شده صفر یا منفی است.',
    math: `مارجین نهایی: ${fa(Math.max(ctx.newMargin, 0))}`,
  })

  // --- 5. Same-direction candles (only when configured > 0) ---
  if (settings.minSameDirectionCandles > 0) {
    const required = settings.minSameDirectionCandles
    const aligned = ctx.postSignalCandles.filter((c) =>
      isLong ? c.close > c.open : c.close < c.open
    )
    const consecutive = countTrailingConsecutive(ctx.postSignalCandles, isLong)
    const candlesPassed = consecutive >= required
    results.push({
      control: 'SAME_DIRECTION_CANDLES',
      passed: candlesPassed,
      message: candlesPassed
        ? `تأیید ${required} کندل هم‌جهت انجام شد (${consecutive} کندل).`
        : `کنترل کندل هم‌جهت رد شد — ${consecutive} از ${required} کندل هم‌جهت هستند.`,
      math: `کندل‌های هم‌جهت متوالی بعد از سیگنال: ${consecutive} | حد لازم: ${required}`,
    })
    void aligned
  }

  const rejection = results.find((r) => !r.passed)
  return { passed: !rejection, results, rejection }
}

function countTrailingConsecutive(
  candles: { open: number; close: number }[],
  isLong: boolean
): number {
  let count = 0
  for (let i = candles.length - 1; i >= 0; i--) {
    const ok = isLong ? candles[i].close > candles[i].open : candles[i].close < candles[i].open
    if (ok) count++
    else break
  }
  return count
}
