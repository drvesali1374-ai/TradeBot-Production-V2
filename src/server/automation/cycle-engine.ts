/**
 * Cycle engine — the single execution path for BOTH manual runs
 * («یک چرخه» button) and the Cloudflare cron. No other module places
 * orders or generates signals.
 *
 * Flow (reference audit-1 §A, 14 steps + persistence discipline):
 *  1. cycleId + start                     8. price + balance + positions
 *  2. one-time settings/symbols load      9. close opposite positions
 *  3. concurrency lock                   10. margin + 6 risk controls
 *  4. select ready symbol (tradeWaitTime) 11. place order (ToobitClient)
 *  5. market data (closed candles)       12. verify order + TP/SL
 *  6. indicators + signals (core)        13. Bale notification
 *  7. signal selection + freshness        14. persist (single flush) + unlock
 */
import {
  analyzeSymbol,
  isSignalExpired,
  resolveSignalStatus,
  evaluateRiskControls,
  calculateNewMargin,
  getSymbolMargin,
  intervalToMs,
  splitClosedCandles,
  STRATEGY_VERSION,
} from '@/core'
import { fullSymbol } from '@/server/exchanges/toobit/endpoints'
import type { CycleResult, CycleAction, SymbolEntry, LogRecord, StepLog, LogStatus } from '@/core/types'
import type { AutomationSettings } from '@/core/settings'
import { getStorage, STORAGE_KEYS, WriteBatcher, LOGS_CAP } from '@/server/storage'
import { ToobitClient } from '@/server/exchanges/toobit'
import { loadAutomationSettings, loadAccountSettings } from '@/server/configuration/settings-service'
import { sendBale } from '@/server/notifications/bale'
import { tryAcquireLock, releaseLock } from './cycle-lock'
import { CycleContext } from './cycle-context'

export interface RunCycleOptions {
  source: 'manual' | 'cron'
  /** Force a specific symbol (bypasses tradeWaitTime) */
  symbolOverride?: string
}

function makeCycleId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function fa(n: number, digits = 2): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export async function runCycle(options: RunCycleOptions): Promise<CycleResult> {
  const cycleId = makeCycleId()
  const store = getStorage()
  const storage = store
  storage.resetCycleBudget()

  const batcher = new WriteBatcher(store)
  const ctx = new CycleContext(cycleId, batcher)
  const startedAt = Date.now()

  const finish = (action: CycleAction, extra: Partial<CycleResult> = {}): CycleResult => {
    const result: CycleResult = {
      cycleId,
      symbol: ctx.selectedSymbol?.name ?? options.symbolOverride ?? null,
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      source: options.source,
      action,
      steps: ctx.steps,
      storage: { reads: store.budget().reads, writes: store.budget().writes },
      ...extra,
    }
    return result
  }

  try {
    /* ---- Step 1-2: settings & symbols (single read each) ---- */
    ctx.beginStep()
    ctx.settings = (await ctx.track(STORAGE_KEYS.automationSettings, () =>
      loadAutomationSettings()
    )) as AutomationSettings
    ctx.account = (await ctx.track(STORAGE_KEYS.accountSettings, () =>
      loadAccountSettings()
    )) as Awaited<ReturnType<typeof loadAccountSettings>>
    const symbols = (await ctx.track<SymbolEntry[]>(STORAGE_KEYS.symbols, () =>
      store.get<SymbolEntry[]>(STORAGE_KEYS.symbols)
    )) ?? []
    ctx.symbols = symbols.length
      ? symbols
      : [
          { id: 1, name: 'DOT', status: 'waiting', errorCount: 0, lastCycleTime: null },
          { id: 2, name: 'BTC', status: 'waiting', errorCount: 0, lastCycleTime: null },
          { id: 3, name: 'ETH', status: 'waiting', errorCount: 0, lastCycleTime: null },
        ]
    const client = new ToobitClient({ apiKey: ctx.account.apiKey, secretKey: ctx.account.secretKey })
    ctx.step('بارگذاری تنظیمات', 'ok', `تنظیمات و ${ctx.symbols.length} نماد بارگذاری شد`, {
      settingsVersion: STRATEGY_VERSION,
      hasCredentials: client.hasCredentials,
    })
    if (!client.hasCredentials) {
      ctx.step('بررسی اعتبارنامه', 'warning', 'اعتبارنامه صرافی تنظیم نشده است — عملیات حساب و سفارش در این چرخه متوقف می‌شود', {
        hint: 'کلید API و Secret را در صفحه تنظیمات وارد کنید',
      })
    }

    /* ---- Step 3: lock ---- */
    ctx.beginStep()
    const lock = await tryAcquireLock(options.source, cycleId)
    if (!lock.acquired) {
      ctx.step('قفل اجرا', 'warning', 'چرخه دیگری در حال اجراست — اجرای هم‌زمان رد شد', {
        heldBy: lock.heldBy?.cycleId,
      })
      return finish('ERROR', { error: 'چرخه موازی در حال اجراست' })
    }
    ctx.step('قفل اجرا', 'ok', 'قفل اجرا فعال شد')

    try {
      /* ---- Step 4: select ready symbol ---- */
      ctx.beginStep()
      const now = Date.now()
      const waitMs = ctx.settings.tradeWaitTime * 60_000
      let idx = ctx.symbols.findIndex(
        (s) => !s.lastCycleTime || now - s.lastCycleTime >= waitMs
      )
      const override = options.symbolOverride?.toUpperCase()
      if (override) {
        idx = ctx.symbols.findIndex((s) => s.name === override)
        if (idx < 0) {
          ctx.symbols.push({
            id: Math.max(...ctx.symbols.map((s) => s.id), 0) + 1,
            name: override,
            status: 'waiting',
            errorCount: 0,
            lastCycleTime: null,
          })
          idx = ctx.symbols.length - 1
        }
      }
      if (idx < 0) {
        ctx.step('انتخاب نماد', 'skipped', 'نماد آماده‌ای برای چرخه وجود ندارد (زمان انتظار)')
        return finish('NO_READY_SYMBOL')
      }
      ctx.symbolIndex = idx
      const symbol = ctx.symbols[idx].name
      ctx.markCycleStart()
      ctx.step('انتخاب نماد', 'ok', `نماد ${symbol} انتخاب شد`, { symbol, tradeWaitTime: ctx.settings.tradeWaitTime })

      /* ---- Step 5: market data ---- */
      ctx.beginStep()
      let candles
      try {
        const raw = await client.getKlines(symbol, ctx.settings.interval, ctx.settings.limit)
        const intervalMs = intervalToMs(ctx.settings.interval)
        candles = raw.map((c) => ({ ...c, closeTime: c.openTime + intervalMs }))
        const { closed, forming } = splitClosedCandles(candles, now)
        ctx.step('داده بازار', 'ok', `${candles.length} کندل دریافت شد (${closed.length} بسته‌شده)`, {
          total: candles.length,
          closed: closed.length,
          forming: forming ? 1 : 0,
          lastClosedAt: closed.length ? closed[closed.length - 1].closeTime : null,
        })
      } catch (e) {
        ctx.step('داده بازار', 'failed', `دریافت کندل‌ها ناموفق: ${e instanceof Error ? e.message : 'خطا'}`)
        throw e
      }

      /* ---- Step 6-7: analysis + signal generation ---- */
      ctx.beginStep()
      const analysis = analyzeSymbol({ symbol, candles, settings: ctx.settings, now })
      const pending = analysis.signals.length ? analysis.signals[analysis.signals.length - 1] : null
      ctx.step('محاسبات و سیگنال', 'ok', `${analysis.signals.length} سیگنال در تاریخچه تحلیل تولید شد`, {
        signals: analysis.signals.length,
        lastPrice: analysis.lastPrice,
        strategy: 'FakeBreakout',
      })

      if (!pending) {
        ctx.step('انتخاب سیگنال', 'skipped', 'سیگنالی برای بررسی وجود ندارد')
        ctx.markCycleEnd()
        await batcher.persist()
        return finish('NO_SIGNAL')
      }

      /* ---- Step 8: trade history + signal status (REFERENCE GATE) ---- */
      // Reference (automation-manager.js:2778-2849 + 1414-1445): the
      // latest signal is tradeable ONLY in «در انتظار» status — history
      // fills decide. Without this gate the engine could re-trade an
      // already-opened signal on the next cycle (critical fidelity fix).
      ctx.beginStep()
      let historyFills: { time: number; side: 'LONG' | 'SHORT'; symbol: string; price: number | null }[] = []
      let lastOpenPrice: number | null = null
      try {
        const rawFills = await client.getUserTrades(symbol, 100)
        const full = fullSymbol(symbol).toUpperCase()
        for (const row of rawFills as Record<string, unknown>[]) {
          const t = Number(row.time)
          const rowSide = String(row.side ?? '')
          const rowSym = String(row.symbol ?? '').toUpperCase()
          if (!Number.isFinite(t) || !rowSide || rowSym !== full) continue
          if (!rowSide.includes('OPEN')) continue
          const dir: 'LONG' | 'SHORT' = rowSide.includes('BUY') ? 'LONG' : 'SHORT'
          const price = Number(row.price)
          historyFills.push({ time: t, side: dir, symbol: rowSym, price: Number.isFinite(price) ? price : null })
        }
        // getLastEntryPrice (ref :3440-3475): latest same-direction OPEN fill
        for (let i = historyFills.length - 1; i >= 0; i--) {
          if (historyFills[i].price != null) {
            lastOpenPrice = historyFills[i].price as number
            break
          }
        }
        ctx.step('تاریخچه معاملات', 'ok', `${historyFills.length} معامله بازکردن برای نماد یافت شد`, {
          fills: historyFills.length,
          lastOpenPrice,
        })
      } catch (e) {
        // History unavailable → cannot verify status; the reference would
        // also fail the cycle here (fetchPositionHistory throws) — abort
        // rather than risk re-opening an already-opened signal.
        ctx.step('تاریخچه معاملات', 'failed', `دریافت تاریخچه ناموفق: ${e instanceof Error ? e.message : 'خطا'}`)
        throw e
      }

      const statuses = resolveSignalStatus(analysis.signals, historyFills, ctx.settings.signalExpirationHours, now)
      const pendingStatus = statuses.get(pending.id) ?? 'NOT_OPENED'
      if (pendingStatus === 'OPENED') {
        ctx.step('وضعیت سیگنال', 'skipped', 'این سیگنال قبلاً باز شده است — رد شد', {
          signalId: pending.id,
          status: pendingStatus,
        })
        ctx.markCycleEnd()
        await batcher.persist()
        return finish('SIGNAL_ALREADY_OPENED', { signal: pending })
      }
      ctx.step('وضعیت سیگنال', 'ok', 'سیگنال در وضعیت «در انتظار» است — قابل معامله', {
        signalId: pending.id,
        status: pendingStatus,
      })

      /* ---- Step 8b: signal freshness ---- */
      ctx.beginStep()
      if (isSignalExpired(pending, ctx.settings, now)) {
        ctx.step('بررسی تازگی سیگنال', 'skipped', 'سیگنال منقضی شده است', {
          signalId: pending.id,
          ageHours: (now - pending.signalConfirmedAt) / 3600_000,
          expirationHours: ctx.settings.signalExpirationHours,
        })
        ctx.markCycleEnd()
        await batcher.persist()
        return finish('SIGNAL_EXPIRED')
      }
      ctx.step('بررسی تازگی سیگنال', 'ok', 'سیگنال معتبر و تازه است', {
        signalId: pending.id,
        side: pending.side,
        price: pending.price,
        tp: pending.tp,
        sl: pending.sl,
        confirmedAt: pending.signalConfirmedAt,
      })

      /* ---- Step 9: price, balance, positions ---- */
      ctx.beginStep()
      // REFERENCE FIDELITY (mission §6): the cycle price is the close of
      // the most recent 1h kline (fetchPrice, automation-manager.js:2763-
      // 2776 — `klines[0][4]` of a limit=1 fetch = the FORMING candle's
      // current close). The order-qty price stays the ticker (the ref's
      // create-position route fetches the ticker server-side).
      const price = analysis.allCandles.length
        ? analysis.allCandles[analysis.allCandles.length - 1].close
        : await client.getTickerPrice(symbol)
      const balance = await client.getBalance()
      const positions = await client.getOpenPositions()
      const symbolPositions = positions.filter((p) => p.symbol.toUpperCase().startsWith(`${symbol.toUpperCase()}-`))
      ctx.step('حساب و پوزیشن‌ها', 'ok', 'قیمت، موجودی و پوزیشن‌ها دریافت شد', {
        price,
        priceSource: 'آخرین کندل (مطابق مرجع)',
        total: balance.total,
        free: balance.free,
        openPositions: positions.length,
        symbolPositions: symbolPositions.length,
      })

      /* ---- Step 10: close opposite positions ---- */
      ctx.beginStep()
      const targetSide = pending.side === 'Long' ? 'LONG' : 'SHORT'
      const oppositeSide = pending.side === 'Long' ? 'SHORT' : 'LONG'
      const opposite = symbolPositions.filter((p) => p.side === oppositeSide && ((p.available ?? p.qty) ?? 0) > 0)
      let oppositeClosed = false
      if (opposite.length > 0) {
        const closeRes = await client.closePosition({ symbol, side: oppositeSide })
        oppositeClosed = closeRes.closed > 0
        ctx.step(
          'بستن پوزیشن مخالف',
          closeRes.closed > 0 ? 'ok' : 'failed',
          closeRes.closed > 0
            ? `${closeRes.closed} پوزیشن مخالف بسته شد`
            : 'بستن پوزیشن مخالف ناموفق بود — مطابق مرجع، چرخه ادامه می‌یابد',
          { closed: closeRes.closed, total: closeRes.total, errors: closeRes.errors }
        )
        // REFERENCE FIDELITY (mission §6): close failure is NON-FATAL
        // (automation-manager.js:2921-2924 downgrades errors and the
        // cycle proceeds to open the new position regardless).
      } else {
        ctx.step('بستن پوزیشن مخالف', 'skipped', 'پوزیشن مخالفی وجود ندارد')
      }

      /* ---- Step 10b: refresh open positions (reference step 11) ---- */
      ctx.beginStep()
      let freshPositions = symbolPositions
      try {
        freshPositions = (await client.getOpenPositions()).filter(
          (p) => p.symbol.toUpperCase().startsWith(`${symbol.toUpperCase()}-`)
        )
        ctx.step('بررسی پوزیشن‌های باز', 'ok', `${freshPositions.length} پوزیشن باز برای نماد`, {
          symbolPositions: freshPositions.length,
        })
      } catch (e) {
        ctx.step('بررسی پوزیشن‌های باز', 'warning', `بررسی مجدد ناموفق (${e instanceof Error ? e.message : 'خطا'}) — از داده قبلی استفاده شد`)
      }

      /* ---- Step 11: margin + risk controls ---- */
      ctx.beginStep()
      const isLong = pending.side === 'Long'
      const entryMarginPercent = isLong ? ctx.settings.entryMarginPercentLong : ctx.settings.entryMarginPercentShort
      const leverage = isLong ? ctx.settings.leverageLong : ctx.settings.leverageShort
      const newMargin = calculateNewMargin(balance.total, entryMarginPercent)

      const postSignalCandles = analysis.allCandles
        .filter((c) => c.openTime > pending.candleOpenTime)
        .map((c) => ({ open: c.open, close: c.close }))

      const risk = evaluateRiskControls(
        pending,
        {
          balance: { total: balance.total, free: balance.free },
          newMargin,
          price,
          symbolPositions: freshPositions,
          postSignalCandles,
          lastOpenPrice,
        },
        ctx.settings
      )
      const riskData = risk.results.map((r) => ({ control: r.control, passed: r.passed }))
      if (!risk.passed && risk.rejection) {
        ctx.step('کنترل ریسک', 'skipped', risk.rejection.message, { controls: riskData, math: risk.rejection.math })
        await notifyRejection(ctx, risk.rejection, pending, balance, newMargin)
        ctx.markCycleEnd()
        await batcher.persist()
        return finish('RISK_REJECTED', { reason: risk.rejection.control, signal: pending })
      }
      ctx.step('کنترل ریسک', 'ok', 'همه کنترل‌های ریسک تأیید شدند', { controls: riskData, newMargin, leverage })

      /* ---- Step 12: place order ---- */
      ctx.beginStep()
      const executionRequestedAt = Date.now()
      const order = await client.openPosition({
        symbol,
        side: targetSide,
        margin: newMargin,
        leverage,
        tp: pending.tp,
        sl: pending.sl,
        clientOrderId: pending.id,
      })
      const orderSubmittedAt = Date.now()
      ctx.step('ثبت سفارش', order.tpslConfirmed ? 'ok' : 'warning', `سفارش ثبت شد — ${order.qty} قرارداد @ ${fa(order.price)}`, {
        orderId: order.orderId,
        qty: order.qty,
        price: order.price,
        margin: newMargin,
        leverage,
        tp: pending.tp,
        sl: pending.sl,
        tpslConfirmed: order.tpslConfirmed,
        tpslError: order.tpslError,
        executionRequestedAt,
        orderSubmittedAt,
      })

      /* ---- Step 13: Bale notification ---- */
      ctx.beginStep()
      await notifyOpen(ctx, pending, order, leverage, newMargin)

      /* ---- Step 14: persist ---- */
      ctx.beginStep()
      ctx.markCycleEnd()
      const writes = await batcher.persist()
      ctx.step('ذخیره‌سازی', 'ok', `تغییرات ذخیره شد (${writes} عملیات نوشتن)`, { writes, reads: store.budget().reads })

      const action: CycleAction = order.tpslConfirmed
        ? oppositeClosed
          ? 'OPPOSITE_CLOSED_THEN_OPENED'
          : 'POSITION_OPENED'
        : 'POSITION_OPENED_TPSL_FAILED'

      return finish(action, {
        signal: pending,
        order: {
          orderId: order.orderId,
          qty: order.qty,
          price: order.price,
          tp: pending.tp,
          sl: pending.sl,
          tpslConfirmed: order.tpslConfirmed,
        },
      })
    } finally {
      await releaseLock(cycleId)
    }
  } catch (e) {
    // Error path: symbol error accounting + rejection of parallel write
    const message = e instanceof Error ? e.message : 'خطای ناشناخته'
    const { skipped } = ctx.markError(ctx.settings?.allowedErrors ?? 3)
    ctx.step('خطای چرخه', 'failed', message, { symbol: ctx.selectedSymbol?.name ?? null })
    try {
      await sendBale(
        { baleToken: ctx.account?.baleToken ?? '', baleChatId: ctx.account?.baleChatId ?? '' },
        `#خطا\nنماد: ${ctx.selectedSymbol?.name ?? '-'}\nپیام: ${message}\nزمان: ${new Date().toISOString()}`
      )
    } catch {
      /* notification failures never break the cycle */
    }
    const result = finish('ERROR', { error: message })
    try {
      await batcher.persist()
    } catch {
      /* best effort */
    }
    result.storage = { reads: store.budget().reads, writes: store.budget().writes }
    return result
  }
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

async function notifyRejection(
  ctx: CycleContext,
  rejection: { control: string; message: string; math: string },
  signal: { symbol: string; side: string; price: number },
  balance: { total: number; free: number },
  newMargin: number
): Promise<void> {
  const tags: Record<string, string> = {
    SAFE_ASSET: '#دارایی_امن',
    PRICE_DISTANCE: '#فاصله_قیمت',
    MAX_MARGIN: '#سقف_مارجین',
    POSITIVE_MARGIN: '#مارجین_مثبت',
    SAME_DIRECTION_CANDLES: '#کندل_هم‌جهت',
  }
  const text = [
    tags[rejection.control] ?? '#کنترل_ریسک',
    `نماد: ${signal.symbol}`,
    `سیگنال: ${signal.side} @ ${fa(signal.price)}`,
    rejection.message,
    `قیاس: ${rejection.math}`,
    `موجودی کل: ${fa(balance.total)} | آزاد: ${fa(balance.free)} | مارجین جدید: ${fa(newMargin)}`,
  ]
    .filter(Boolean)
    .join('\n')
  try {
    await sendBale({ baleToken: ctx.account.baleToken, baleChatId: ctx.account.baleChatId }, text)
  } catch {
    /* ignore */
  }
}

async function notifyOpen(
  ctx: CycleContext,
  signal: { symbol: string; side: string; price: number; tp: number; sl: number; signalConfirmedAt: number },
  order: { qty: number; price: number; tpslConfirmed: boolean },
  leverage: number,
  margin: number
): Promise<void> {
    const text = [
    '#ورود_پوزیشن',
    `نماد: ${signal.symbol}`,
    `جهت: ${signal.side === 'Long' ? 'لانگ (Long)' : 'شورت (Short)'}`,
    `مقدار: ${order.qty} قرارداد`,
    `قیمت ورود: ${fa(order.price)}`,
    `حد سود (TP): ${fa(signal.tp)}`,
    `حد ضرر (SL): ${fa(signal.sl)}`,
    `اهرم: ${leverage}x`,
    `مارجین: ${fa(margin)} USDT`,
    order.tpslConfirmed ? 'TP/SL: ثبت شد ✓' : 'TP/SL: ثبت نشد — بررسی دستی لازم است ⚠',
    `زمان تأیید سیگنال: ${new Date(signal.signalConfirmedAt).toISOString()}`,
    `زمان ثبت سفارش: ${new Date().toISOString()}`,
  ].join('\n')
  try {
    await sendBale({ baleToken: ctx.account.baleToken, baleChatId: ctx.account.baleChatId }, text)
    ctx.step('اعلان بله', 'ok', 'اعلان ورود ارسال/صف شد')
  } catch {
    ctx.step('اعلان بله', 'warning', 'ارسال اعلان ناموفق بود')
  }
}

/* ------------------------------------------------------------------ */
/* Persist result + logs (called by the API layer, NOT by the engine   */
/* itself — the engine returns the result; the caller decides what to  */
/* store. This keeps storage concerns separated).                      */
/* ------------------------------------------------------------------ */

/** Internal StepStatus → persisted LogStatus (mission §5). */
const STEP_TO_LOG_STATUS: Record<StepLog['status'], LogStatus> = {
  ok: 'SUCCESS',
  info: 'INFO',
  skipped: 'SKIPPED',
  warning: 'WARNING',
  failed: 'ERROR',
}

/** Strip any secret-looking keys from step data before persisting. */
function sanitizeStepData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) {
    if (/secret|password|token|apikey|api_key/i.test(k)) continue
    out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * Persist the cycle outcome: lastCycleResult + the cycle's steps as
 * unified log records (mission §5) — real process names, statuses and
 * technical details (risk controls, orderId, API errors), one record
 * per step, NO duplicates.
 *
 * KV discipline: the log array is read once, merged with the new events
 * IN MEMORY and written back in exactly ONE put — a 14-step cycle costs
 * one logs write, not fourteen (mission §5 KV budget).
 */
export async function persistCycleOutcome(result: CycleResult): Promise<void> {
  const store = getStorage()

  const newRecords: LogRecord[] = result.steps.map((s) => ({
    id: 0, // renumbered below
    symbol: result.symbol,
    action: 'automation_cycle',
    process: s.name,
    status: STEP_TO_LOG_STATUS[s.status] ?? 'INFO',
    message: s.message,
    cycleId: result.cycleId,
    details: sanitizeStepData(s.data),
    source: result.source,
    durationMs: s.durationMs ?? null,
    step: s.step,
    created_at: new Date(s.at).toISOString(),
  }))

  const logs = (await store.get<LogRecord[]>(STORAGE_KEYS.logs)) ?? []
  const merged = [...newRecords, ...logs]
    .filter((r) => r && typeof r === 'object') // drop malformed rows
    .slice(0, LOGS_CAP)
  merged.forEach((r, i) => (r.id = i + 1))

  // exactly TWO puts per cycle — the result and the (single) log array
  await Promise.all([
    store.put(STORAGE_KEYS.lastCycleResult, result),
    store.put(STORAGE_KEYS.logs, merged),
  ])
}

/** Closed-positions history notification (checkClosedPositionsHistory). */
export async function checkClosedPositionsHistory(): Promise<{ notified: number }> {
  const store = getStorage()
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  const settings = await loadAutomationSettings()

  let lastCloseTime = (await store.get<number>(STORAGE_KEYS.lastPositionCloseTime)) ?? 0
  const history = await client.getHistoryPositions()
  if (history.length === 0) return { notified: 0 }

  const newest = history[0]
  if (newest.closeTime === lastCloseTime || lastCloseTime === 0) {
    if (lastCloseTime === 0) await store.put(STORAGE_KEYS.lastPositionCloseTime, newest.closeTime)
    return { notified: 0 }
  }

  const fresh = history
    .filter((h) => h.closeTime > lastCloseTime)
    .slice(0, settings.closedPositionsNotifyCount)

  for (const h of fresh) {
    const text = [
      '#تاریخچه_بسته',
      `نماد: ${h.symbol}`,
      `جهت: ${h.side}`,
      `قیمت بستن: ${fa(h.closePrice)}`,
      `سود/زیان: ${fa(h.realizedPnl)} USDT (${fa(h.realizedPnlRate)}%)`,
      `زمان: ${new Date(h.closeTime).toISOString()}`,
    ].join('\n')
    try {
      await sendBale({ baleToken: account.baleToken, baleChatId: account.baleChatId }, text)
    } catch {
      /* ignore */
    }
  }
  await store.put(STORAGE_KEYS.lastPositionCloseTime, newest.closeTime)
  return { notified: fresh.length }
}
