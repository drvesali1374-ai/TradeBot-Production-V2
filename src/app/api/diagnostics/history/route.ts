/**
 * Closed positions history + derived stats (real exchange data only).
 * No credentials → explicit error (no simulated history, mission §13).
 */
import { json, requireAuth, isResponse } from '../../_lib'
import { ToobitClient, errorCode } from '@/server/exchanges/toobit'
import { loadAccountSettings } from '@/server/configuration/settings-service'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const history = await client.getHistoryPositions()
    const winning = history.filter((h) => h.realizedPnl > 0).length
    const losing = history.filter((h) => h.realizedPnl < 0).length
    const totalPnl = history.reduce((s, h) => s + h.realizedPnl, 0)
    const stats = { total: history.length, winning, losing, totalPnl: Math.round(totalPnl * 10000) / 10000 }
    return json({ success: true, history: history.slice(0, 60), stats })
  } catch (e) {
    return json(
      { success: false, error: e instanceof Error ? e.message : 'خطا', code: errorCode(e), history: [], stats: null },
      errorCode(e) === 'NO_CREDENTIALS' ? 200 : 502
    )
  }
}
