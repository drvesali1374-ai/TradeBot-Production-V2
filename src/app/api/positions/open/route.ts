/** Read-only open positions. */
import { json, requireAuth, isResponse } from '../../_lib'
import { ToobitClient } from '@/server/exchanges/toobit'
import { loadAccountSettings } from '@/server/configuration/settings-service'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const positions = await client.getOpenPositions()
    return json({ success: true, positions, mode: client.mode, fetchedAt: Date.now() })
  } catch (e) {
    return json(
      { success: false, error: `دریافت پوزیشن‌ها ناموفق: ${e instanceof Error ? e.message : 'خطا'}`, positions: [], mode: client.mode },
      502
    )
  }
}
