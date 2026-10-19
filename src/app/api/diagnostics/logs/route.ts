/** Read-only logs feed. */
import { json, requireAuth, isResponse } from '../../_lib'
import { getStorage, STORAGE_KEYS } from '@/server/storage'
import type { LogRecord } from '@/core/types'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const limit = Math.min(200, Math.max(1, Number(new URL(req.url).searchParams.get('limit') || 60)))
  const logs = (await getStorage().get<LogRecord[]>(STORAGE_KEYS.logs)) ?? []
  return json({ success: true, logs: logs.slice(0, limit) })
}
