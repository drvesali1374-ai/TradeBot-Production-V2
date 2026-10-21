/**
 * GET /api/diagnostics/symbol-stats — per-symbol closed-trade statistics
 * (mission §8). Read-only. One aggregate historyPositions call (limit 200
 * — the live cap); coverage limit is surfaced to the UI (`truncated`) so
 * a partial exchange history is never presented as complete. No fake
 * zero-stats on fetch errors — the error is explicit.
 */
import { json, requireAuth, isResponse } from '../../_lib'
import { ToobitClient, errorCode } from '@/server/exchanges/toobit'
import { loadAccountSettings } from '@/server/configuration/settings-service'
import { computeSymbolStats } from '@/server/analytics/symbol-stats'

const SOURCE_LIMIT = 200 // live-verified cap of historyPositions

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const history = await client.getHistoryPositions(SOURCE_LIMIT)
    const result = computeSymbolStats(history, { sourceLimit: SOURCE_LIMIT })
    return json({
      success: true,
      ...result,
      sourceLimit: SOURCE_LIMIT,
      fetchedAt: Date.now(),
    })
  } catch (e) {
    return json(
      { success: false, error: e instanceof Error ? e.message : 'خطا', code: errorCode(e), stats: [] },
      errorCode(e) === 'NO_CREDENTIALS' ? 200 : 502
    )
  }
}
