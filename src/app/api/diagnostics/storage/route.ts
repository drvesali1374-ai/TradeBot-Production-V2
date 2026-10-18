/** Storage budget report — reads/writes instrumentation. */
import { json, requireAuth, isResponse } from '../../_lib'
import { getStorage } from '@/server/storage'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  return json({ success: true, budget: getStorage().budget() })
}
