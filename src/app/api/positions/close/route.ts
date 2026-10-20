/** Manual close position — order path (auth required). Requires credentials. */
import { json, jsonError, readJsonBody, requireAuth, isResponse } from '../../_lib'
import { ToobitClient, errorCode } from '@/server/exchanges/toobit'
import { loadAccountSettings } from '@/server/configuration/settings-service'

export async function POST(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const body = await readJsonBody<{ symbol?: string; direction?: 'long' | 'short' }>(req)
  if (!body?.symbol || !body.direction) return jsonError('symbol و direction الزامی است', 400)
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const res = await client.closePosition({
      symbol: body.symbol,
      side: body.direction === 'long' ? 'LONG' : 'SHORT',
    })
    return json({
      success: res.closed > 0,
      closed: res.closed,
      total: res.total,
      errors: res.errors,
    })
  } catch (e) {
    return json(
      { success: false, error: e instanceof Error ? e.message : 'خطا', code: errorCode(e), closed: 0, total: 0, errors: [] },
      errorCode(e) === 'NO_CREDENTIALS' ? 200 : 502
    )
  }
}
