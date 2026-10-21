/**
 * Read-only open positions WITH TP/SL (mission §2). No credentials →
 * explicit error, no fake rows. TP/SL tri-state: `tpslStatus` on every
 * position ('ok' = read-back succeeded; 'unknown' = fetch failed →
 * UI shows «نامشخص» instead of a fabricated «تنظیم نشده»).
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
    const positions = await client.getOpenPositionsFull()
    return json({ success: true, positions, fetchedAt: Date.now() })
  } catch (e) {
    return json(
      { success: false, error: e instanceof Error ? e.message : 'خطا', code: errorCode(e), positions: [] },
      errorCode(e) === 'NO_CREDENTIALS' ? 200 : 502
    )
  }
}
