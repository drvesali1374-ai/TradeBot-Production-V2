/** Read-only ticker price. */
import { json, jsonError, requireAuth, isResponse } from '../../_lib'
import { ToobitClient } from '@/server/exchanges/toobit'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const symbol = new URL(req.url).searchParams.get('symbol')
  if (!symbol) return jsonError('symbol الزامی است', 400)
  const client = new ToobitClient({ apiKey: '', secretKey: '' })
  try {
    const price = await client.getTickerPrice(symbol)
    return json({ success: true, price, symbol })
  } catch (e) {
    return jsonError(`دریافت قیمت ناموفق: ${e instanceof Error ? e.message : 'خطا'}`, 502)
  }
}
