/** Read-only market candles. Auth required (app data policy). */
import { json, jsonError, requireAuth, isResponse } from '../../_lib'
import { ToobitClient } from '@/server/exchanges/toobit'
import { intervalToMs } from '@/core'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const url = new URL(req.url)
  const symbol = url.searchParams.get('symbol')
  const interval = url.searchParams.get('interval') || '1h'
  const limit = Math.min(2000, Math.max(10, Number(url.searchParams.get('limit') || 500)))
  if (!symbol) return jsonError('symbol الزامی است', 400)
  const client = new ToobitClient({ apiKey: '', secretKey: '' })
  try {
    const candles = await client.getKlines(symbol, interval, limit)
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
