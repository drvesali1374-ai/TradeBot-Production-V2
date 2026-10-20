/**
 * Read-only balance. Read-only endpoints never trigger orders.
 * Without exchange credentials it fails explicitly (mission §13) —
 * no simulated account data is ever returned.
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
    const balance = await client.getBalance()
    return json({ success: true, balance, fetchedAt: Date.now() })
  } catch (e) {
    return json(
      {
        success: false,
        error: e instanceof Error ? e.message : 'خطا',
        code: errorCode(e),
        balance: null,
      },
      errorCode(e) === 'NO_CREDENTIALS' ? 200 : 502
    )
  }
}
