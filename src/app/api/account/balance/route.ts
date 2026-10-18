/** Read-only balance. Read-only endpoints never trigger orders. */
import { json, requireAuth, isResponse } from '../../_lib'
import { ToobitClient } from '@/server/exchanges/toobit'
import { loadAccountSettings } from '@/server/configuration/settings-service'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const account = await loadAccountSettings()
  const client = new ToobitClient({ apiKey: account.apiKey, secretKey: account.secretKey })
  try {
    const balance = await client.getBalance()
    return json({ success: true, balance, mode: client.mode })
  } catch (e) {
    return json(
      { success: false, error: `دریافت موجودی ناموفق: ${e instanceof Error ? e.message : 'خطا'}`, mode: client.mode },
      502
    )
  }
}
