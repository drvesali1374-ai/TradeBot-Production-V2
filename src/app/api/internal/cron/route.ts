/**
 * Cron endpoint — called by the Cloudflare Cron Worker (every 5 minutes).
 * Server-to-server auth via X-Cron-Secret header == CRON_SECRET env.
 * Runs the SAME cycle engine as the manual route.
 */
import { json, jsonError } from '../../_lib'
import type { CycleResult } from '@/core/types'
import { runCycle, persistCycleOutcome, checkClosedPositionsHistory } from '@/server/automation/cycle-engine'

export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET
  const provided = req.headers.get('x-cron-secret')
  if (!secret || provided !== secret) {
    return jsonError('دسترسی غیرمجاز', 401)
  }
  const results: CycleResult[] = []
  const history = { notified: 0 }
  const result = await runCycle({ source: 'cron' })
  await persistCycleOutcome(result)
  results.push(result)
  try {
    const h = await checkClosedPositionsHistory()
    history.notified = h.notified
  } catch {
    /* ignore */
  }
  return json({ success: true, results, history })
}

export async function GET(req: Request) {
  return POST(req)
}
