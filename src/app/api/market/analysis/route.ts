/**
 * Read-only market analysis for a symbol: closed candles + indicators +
 * signals + daily levels — computed by the shared core (the same code
 * the cycle engine uses). NEVER places orders.
 */
import { json, jsonError, requireAuth, isResponse } from '../../_lib'
import { ToobitClient } from '@/server/exchanges/toobit'
import { analyzeSymbol, intervalToMs, resolveSignalStatus } from '@/core'
import { loadAutomationSettings } from '@/server/configuration/settings-service'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol')
  if (!symbol) return jsonError('symbol الزامی است', 400)
  const settings = await loadAutomationSettings()

  const client = new ToobitClient({ apiKey: '', secretKey: '' })
  try {
    const raw = await client.getKlines(symbol, settings.interval, settings.limit)
    const ms = intervalToMs(settings.interval)
    const candles = raw.map((c) => ({ ...c, closeTime: c.openTime + ms }))
    const analysis = analyzeSymbol({ symbol, candles, settings, now: Date.now() })
    // History-based status: demo fills power the UI status; live mode
    // shows PENDING/EXPIRED which the engine resolves at cycle time.
    const statuses = resolveSignalStatus(
      analysis.signals,
      [],
      settings.signalExpirationHours
    )
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
