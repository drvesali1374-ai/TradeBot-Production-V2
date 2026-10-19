/**
 * Manual single-cycle execution («یک چرخه»).
 * Runs the SAME cycle engine as the cron endpoint. Requires session auth.
 * Optional { symbol } in body to target a specific symbol.
 */
import { json, jsonError, readJsonBody, requireAuth, isResponse } from '../../_lib'
import { runCycle, persistCycleOutcome, checkClosedPositionsHistory } from '@/server/automation/cycle-engine'

export async function POST(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const body = await readJsonBody<{ symbol?: string; checkHistory?: boolean }>(req) ?? {}
  const result = await runCycle({ source: 'manual', symbolOverride: body.symbol })
  await persistCycleOutcome(result)
  let history: { notified: number } | null = null
  if (body.checkHistory !== false) {
    try {
      history = await checkClosedPositionsHistory()
    } catch {
      history = null
    }
  }
  return json({ success: true, result, history })
}

export async function GET(req: Request) {
  return POST(req)
}
