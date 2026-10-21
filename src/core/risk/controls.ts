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
  /** Candles AFTER the signal candle — INCLUDING the forming one */
  postSignalCandles: { open: number; close: number }[]
  /**
   * REFERENCE FIDELITY (mission §6): price of the latest same-direction
   * OPEN fill from the exchange trade history (getLastEntryPrice,
   * automation-manager.js:3440-3475) — NOT the open position's avgPrice.
   */
  lastOpenPrice: number | null
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
    // Reference: lastEntryPrice = latest same-direction OPEN fill from
    // the trade history; null when none exists (control then skipped).
    const knownEntry = ctx.lastOpenPrice
    if (knownEntry == null) {
      // No same-direction OPEN fill in history — reference skips this
      // control entirely (getLastEntryPrice → null → condition unmet).
      results.push({
        control: 'PRICE_DISTANCE',
        passed: true,
        message: 'کنترل فاصله قیمت نادیده گرفته شد — ورودی هم‌جهت در تاریخچه یافت نشد (مطابق مرجع).',
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
  // REFERENCE FIDELITY (mission §6, automation-manager.js:2341-2434):
  //   candlesAfterSignal = ALL candles after the signal candle (INCLUDING
  //   the forming one); if fewer than required → reject; otherwise the
  //   FIRST `required` candles must EACH be same-direction (strict close
  //   vs open; doji → reject). PREFIX semantics — not trailing-runs.
  if (settings.minSameDirectionCandles > 0) {
    const required = settings.minSameDirectionCandles
    const after = ctx.postSignalCandles
    const enough = after.length >= required
    let allSame = enough
    if (enough) {
      for (let k = 0; k < required; k++) {
        const c = after[k]
        const same = isLong ? c.close > c.open : c.close < c.open
        if (!same) {
          allSame = false
          break
        }
      }
    }
    results.push({
      control: 'SAME_DIRECTION_CANDLES',
      passed: allSame,
      message: allSame
        ? `تأیید ${required} کندل هم‌جهت انجام شد.`
        : enough
          ? `کنترل کندل هم‌جهت رد شد — ${required} کندل اول بعد از سیگنال، همه هم‌جهت نیستند.`
          : `کنترل کندل هم‌جهت رد شد — کندل‌های بعد از سیگنال کافی نیستند (${after.length} از ${required}).`,
      math: `کندل‌های بعد از سیگنال: ${after.length} (شامل کندل جاری) | حد لازم: ${required} | بررسی: ${required} کندل اول`,
    })
  }

  const rejection = results.find((r) => !r.passed)
  return { passed: !rejection, results, rejection }
}
