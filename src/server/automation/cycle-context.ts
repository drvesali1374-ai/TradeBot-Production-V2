/**
 * Cycle context — in-memory aggregation of ALL state changes during one
 * cycle (instruction §4.1). Nothing writes to storage mid-cycle; the
 * engine's persist step flushes only real changes through the batcher.
 */
import type { AutomationSettings, AccountSettings } from '@/core/settings'
import type { SymbolEntry, StepLog } from '@/core/types'
import type { WriteBatcher } from '@/server/storage'
import { STORAGE_KEYS } from '@/server/storage'

export class CycleContext {
  readonly startedAt: number
  readonly cycleId: string
  settings!: AutomationSettings
  account!: AccountSettings

  symbols!: SymbolEntry[]
  symbolIndex = -1

  /** Step-by-step trace for the automation panel — also the canonical
   * event stream persisted to the shared log table (one record per step,
   * batched into a single KV write by persistCycleOutcome). */
  steps: StepLog[] = []

  stepCounter = 0
  private stepStartedAt = 0

  constructor(cycleId: string, private batcher: WriteBatcher) {
    this.cycleId = cycleId
    this.startedAt = Date.now()
  }

  /** Load & track a value once — later staged writes diff against it. */
  async track<T>(key: string, loader: () => Promise<T | null>): Promise<T | null> {
    const value = await loader()
    this.batcher.track(key, value)
    return value
  }

  stage(key: string, value: unknown): void {
    this.batcher.stage(key, value)
  }

  beginStep(): void {
    this.stepStartedAt = Date.now()
  }

  step(name: string, status: StepLog['status'], message: string, data?: Record<string, unknown>): StepLog {
    const log: StepLog = {
      step: ++this.stepCounter,
      name,
      status,
      message,
      data,
      durationMs: Date.now() - this.stepStartedAt,
      at: Date.now(),
    }
    this.steps.push(log)
    return log
  }

  /* ---------- symbol mutation helpers (in-memory until persist) ----- */

  get selectedSymbol(): SymbolEntry | null {
    return this.symbolIndex >= 0 ? this.symbols[this.symbolIndex] : null
  }

  markCycleStart(): void {
    const sym = this.selectedSymbol
    if (sym) {
      sym.lastCycleTime = Date.now()
      sym.status = 'running'
      this.stage(STORAGE_KEYS.symbols, this.symbols)
    }
  }

  markCycleEnd(): void {
    const sym = this.selectedSymbol
    if (sym) sym.status = 'waiting'
    this.stage(STORAGE_KEYS.symbols, this.symbols)
  }

  markError(allowedErrors: number): { skipped: boolean } {
    const sym = this.selectedSymbol
    if (!sym) return { skipped: false }
    sym.errorCount += 1
    if (sym.errorCount >= allowedErrors) {
      sym.errorCount = 0
      sym.status = 'waiting'
      sym.lastCycleTime = Date.now()
      this.stage(STORAGE_KEYS.symbols, this.symbols)
      return { skipped: true }
    }
    sym.status = 'error'
    this.stage(STORAGE_KEYS.symbols, this.symbols)
    return { skipped: false }
  }
}
