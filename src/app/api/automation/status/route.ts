/** Automation status — last cycle result, symbols, lock, storage budget. Read-only. */
import { json, requireAuth, isResponse } from '../../_lib'
import { getStorage, STORAGE_KEYS } from '@/server/storage'
import { loadAutomationSettings } from '@/server/configuration/settings-service'
import type { CycleResult, SymbolEntry } from '@/core/types'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const store = getStorage()
  const [lastResult, symbols, lock, settings] = await Promise.all([
    store.get<CycleResult>(STORAGE_KEYS.lastCycleResult),
    store.get<SymbolEntry[]>(STORAGE_KEYS.symbols),
    store.get(STORAGE_KEYS.cycleLock),
    loadAutomationSettings(),
  ])
  const budget = store.budget()
  return json({
    success: true,
    lastResult,
    symbols: symbols ?? [],
    lock: lock && (lock as { expiresAt: number }).expiresAt > Date.now() ? lock : null,
    tradeWaitTime: settings.tradeWaitTime,
    storage: budget,
  })
}
