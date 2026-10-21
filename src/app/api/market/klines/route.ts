/**
 * Read-only market candles. Auth required (app data policy).
 *
 * Query params:
 *  - symbol (required), interval (default 1h)
 *  - limit 10..1000 (Toobit documented max is 1000 — clamped here)
 *  - startTime / endTime: OPTIONAL epoch-MILLISECOND window bounds,
 *    validated numeric (mission §7.2 historical-focus support). No times
 *    → latest klines only (Toobit anchors at now). With an endTime the
 *    exchange returns the most recent `limit` candles inside the window.
 */
import { json, jsonError, requireAuth, isResponse } from '../../_lib'
import { ToobitClient } from '@/server/exchanges/toobit'
import { intervalToMs } from '@/core'

/**
 * Parse an optional epoch-ms query param.
 * undefined → param absent; null → present but invalid (caller 400s).
 */
function parseEpochMsParam(raw: string | null): number | undefined | null {
  if (raw == null || raw === '') return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null
  return n
}

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol')
  const interval = url.searchParams.get('interval') || '1h'
  const limit = Math.min(1000, Math.max(10, Number(url.searchParams.get('limit') || 500)))
  if (!symbol) return jsonError('symbol الزامی است', 400)
  const startTime = parseEpochMsParam(url.searchParams.get('startTime'))
  const endTime = parseEpochMsParam(url.searchParams.get('endTime'))
  if (startTime === null || endTime === null) {
    return jsonError('startTime/endTime باید عدد صحیح میلی‌ثانیه (epoch ms) باشد', 400)
  }
  const client = new ToobitClient({ apiKey: '', secretKey: '' })
  try {
    const candles = await client.getKlines(symbol, interval, limit, {
      ...(startTime != null ? { startTime } : {}),
      ...(endTime != null ? { endTime } : {}),
    })
    const ms = intervalToMs(interval)
    return json({
      success: true,
      candles: candles.map((c) => ({ ...c, closeTime: c.openTime + ms })),
      interval,
    })
  } catch (e) {
    return jsonError(`دریافت کندل‌ها ناموفق: ${e instanceof Error ? e.message : 'خطا'}`, 502)
  }
}
