/**
 * Storage interface — KV semantics, swappable adapter.
 *
 * The primary adapter in production is Cloudflare KV; in the sandbox /
 * local dev a JSON-file adapter with identical semantics is used.
 * All adapters must count real reads/writes into the budget.
 */

export interface StorageBudget {
  reads: number
  writes: number
  /** Reads/writes since process start (lifetime counters) */
  lifetimeReads: number
  lifetimeWrites: number
}

export interface KVStore {
  get<T = unknown>(key: string): Promise<T | null>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<string[]>
  /** Budget snapshot for this store instance */
  budget(): StorageBudget
  /** Reset per-cycle counters (keep lifetime) */
  resetCycleBudget(): void
}

export const STORAGE_KEYS = {
  automationSettings: 'automationState:automation_settings',
  accountSettings: 'automationState:settings_apiKeys',
  symbols: 'automationState:automation_symbols',
  authCredentials: 'automationState:auth_credentials',
  lastPositionCloseTime: 'automationState:lastPositionCloseTime',
  pendingBaleMessages: 'automationState:pendingBaleMessages',
  lastCycleResult: 'automationState:lastCycleResult',
  cycleLock: 'automationState:cycleLock',
  logs: 'logs',
} as const

export const LOGS_CAP = 500
export const PENDING_BALE_CAP = 50
