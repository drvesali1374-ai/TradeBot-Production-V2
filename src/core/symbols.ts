/**
 * Default watchlist — the SINGLE source of truth for the DOT/BTC/ETH
 * fallback. Shared by the symbols API route, the status API route and
 * the cycle engine so a fresh deployment (no `automation_symbols` key
 * in storage yet) shows and trades the SAME three symbols instead of
 * an empty table in the UI (bug: status returned `[]` while the engine
 * silently fell back to DOT/BTC/ETH → «این نماد قبلاً اضافه شده است»
 * when re-adding DOT).
 *
 * Consumers that MUTATE entries (engine fallback, symbols route POST)
 * must clone first — `cloneDefaultSymbols()` below — so the shared
 * constant can never be mutated in place.
 */
import type { SymbolEntry } from './types'

export const DEFAULT_SYMBOLS: SymbolEntry[] = [
  { id: 1, name: 'DOT', status: 'waiting', errorCount: 0, lastCycleTime: null },
  { id: 2, name: 'BTC', status: 'waiting', errorCount: 0, lastCycleTime: null },
  { id: 3, name: 'ETH', status: 'waiting', errorCount: 0, lastCycleTime: null },
]

/** Fresh deep copy of the default watchlist (entries are flat objects). */
export function cloneDefaultSymbols(): SymbolEntry[] {
  return DEFAULT_SYMBOLS.map((s) => ({ ...s }))
}
