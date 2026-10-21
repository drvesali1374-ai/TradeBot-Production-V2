/**
 * Read-only market analysis for a symbol: closed candles + indicators +
 * signals + daily levels — computed by the shared core (the same code
 * the cycle engine uses). NEVER places orders.
 */
import { json, jsonError, requireAuth, isResponse } from '../../_lib'
import { ToobitClient, fullSymbol } from '@/server/exchanges/toobit'
import { analyzeSymbol, intervalToMs, resolveSignalStatus } from '@/core'
import { loadAutomationSettings, loadAccountSettings } from '@/server/configuration/settings-service'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol')
  if (!symbol) return jsonError('symbol الزامی است', 400)
  const settings = await loadAutomationSettings()

  // Signed client when credentials exist — signal statuses are resolved
  // against REAL fills (mission §6); on failure they fall back to the
  // age-only PENDING/EXPIRED view (never fabricated OPENED).
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const raw = await client.getKlines(symbol, settings.interval, settings.limit)
    const ms = intervalToMs(settings.interval)
    const candles = raw.map((c) => ({ ...c, closeTime: c.openTime + ms }))
    const analysis = analyzeSymbol({ symbol, candles, settings, now: Date.now() })
    let fills: { time: number; side: 'LONG' | 'SHORT'; symbol: string }[] = []
    if (client.hasCredentials) {
      try {
        const rows = (await client.getUserTrades(symbol, 100)) as Record<string, unknown>[]
        const full = fullSymbol(symbol).toUpperCase()
        for (const row of rows) {
          const t = Number(row.time)
          const rowSide = String(row.side ?? '')
          const rowSym = String(row.symbol ?? '').toUpperCase()
          if (!Number.isFinite(t) || !rowSide.includes('OPEN') || rowSym !== full) continue
          fills.push({ time: t, side: rowSide.includes('BUY') ? 'LONG' : 'SHORT', symbol: rowSym })
        }
      } catch {
        fills = [] // status falls back to age-only resolution
      }
    }
    const statuses = resolveSignalStatus(analysis.signals, fills, settings.signalExpirationHours)
    return json({
      success: true,
      symbol: symbol.toUpperCase(),
      interval: settings.interval,
      candles: analysis.allCandles.slice(-Math.min(analysis.allCandles.length, 300)),
      dailyLevels: analysis.dailyLevels.slice(-Math.min(analysis.dailyLevels.length, 300)),
      lastPrice: analysis.lastPrice,
      signals: analysis.signals.slice(-50).map((s) => ({ ...s, status: statuses.get(s.id) ?? 'NOT_OPENED' })),
      pendingSignal: analysis.signals.length
        ? { ...analysis.signals[analysis.signals.length - 1], status: statuses.get(analysis.signals[analysis.signals.length - 1].id) ?? 'PENDING' }
        : null,
      meta: analysis.meta,
    })
  } catch (e) {
    return jsonError(`تحلیل ناموفق: ${e instanceof Error ? e.message : 'خطا'}`, 502)
  }
}
