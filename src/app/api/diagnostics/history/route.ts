/** Closed positions history + derived stats (from exchange/demo — real source). */
import { json, requireAuth, isResponse } from '../../_lib'
import { ToobitClient, demoEngine } from '@/server/exchanges/toobit'
import { loadAccountSettings } from '@/server/configuration/settings-service'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const history = await client.getHistoryPositions()
    let stats = { total: history.length, winning: 0, losing: 0, totalPnl: 0 }
    if (client.mode === 'demo') {
      stats = await demoEngine.stats()
    } else {
      const winning = history.filter((h) => h.realizedPnl > 0).length
      const losing = history.filter((h) => h.realizedPnl < 0).length
      const totalPnl = history.reduce((s, h) => s + h.realizedPnl, 0)
      stats = { total: history.length, winning, losing, totalPnl: Math.round(totalPnl * 10000) / 10000 }
    }
    return json({ success: true, history: history.slice(0, 60), stats, mode: client.mode })
  } catch (e) {
    return json({ success: false, error: e instanceof Error ? e.message : 'خطا', history: [], stats: null }, 502)
  }
}
