/**
 * Local JSON-file KV adapter — sandbox / fast dev.
 *
 * Mirrors the semantics of the Cloudflare KV adapter (kv-adapter.ts) on top
 * of a single flat JSON file (db/trading_data.json):
 *  - get/put/delete/list with JSON values
 *  - logical read/write budget counters (identical counting rules so
 *    diagnostics are comparable across adapters)
 *  - SERIAL write queue (صف سریال): every put/delete awaits an atomic
 *    full-file flush through a single promise chain — concurrent
 *    read-modify-write sequences can never interleave and lose writes.
 *  - Deep-clone on get/put: callers can never mutate the shared cache in
 *    place (which would silently break WriteBatcher change detection).
 *  - Atomic persistence: write to a temp file then rename — a crash
 *    mid-write can never corrupt the store.
 *  - Path is env-configurable (TB_DATA_FILE / TRADING_DATA_FILE), default
 *    relative to process.cwd() — fixes the reference project's hardcoded
 *    absolute DB_PATH portability bug (audit §F.2).
 *
 * NOTE: this file MUST stay git-tracked. A previous template .gitignore
 * rule ("local-*") silently excluded it from workspace checkpoints and
 * the file was lost on every sandbox restore (2026-10-19 incident).
 */
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type { KVStore, StorageBudget } from './storage-interface'

const DEFAULT_REL_PATH = 'db/trading_data.json'

function dataFilePath(): string {
  const configured = process.env.TB_DATA_FILE || process.env.TRADING_DATA_FILE
  if (configured && configured.trim()) return configured
  return join(process.cwd(), DEFAULT_REL_PATH)
}

function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    // Non-serializable → hand back as-is (KV would stringify it the same way)
    return value
  }
}

export class LocalKVAdapter implements KVStore {
  /** Flat key→value map, loaded lazily from disk on first access. */
  private cache: Map<string, unknown> | null = null
  private loading: Promise<void> | null = null
  /** Serial queue: all mutations flush to disk through this chain. */
  private queue: Promise<unknown> = Promise.resolve()

  private cycleReads = 0
  private cycleWrites = 0
  private lifetimeReads = 0
  private lifetimeWrites = 0

  /* ---------------------------------------------------------------- */
  /* Loading                                                           */
  /* ---------------------------------------------------------------- */

  private async ensureLoaded(): Promise<void> {
    if (this.cache) return
    if (!this.loading) {
      this.loading = (async () => {
        const map = new Map<string, unknown>()
        const path = dataFilePath()
        try {
          const raw = await fs.readFile(path, 'utf8')
          const parsed: unknown = JSON.parse(raw)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
              map.set(key, deepClone(value))
            }
          } else {
            console.warn('[storage:local] store file is not an object — starting empty:', path)
          }
        } catch (err) {
          const code = (err as NodeJS.ErrnoException | null)?.code
          if (code === 'ENOENT') {
            // First run — the file is created on the first write.
          } else if (code === 'EACCES') {
            console.warn('[storage:local] no read permission for', path, '— starting empty')
          } else {
            console.warn('[storage:local] failed to read store, starting empty:', err)
          }
        }
        this.cache = map
      })().catch((err) => {
        // Never let a load failure poison the chain for future callers.
        console.error('[storage:local] load crashed:', err)
        if (!this.cache) this.cache = new Map()
      })
    }
    await this.loading
  }

  /** Atomic full-snapshot flush (must only be called inside the queue). */
  private async flushLocked(): Promise<void> {
    if (!this.cache) return
    const path = dataFilePath()
    const tmp = `${path}.${process.pid}.tmp`
    await fs.mkdir(dirname(path), { recursive: true })
    const snapshot: Record<string, unknown> = {}
    for (const [key, value] of this.cache) snapshot[key] = value
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    await fs.rename(tmp, path)
  }

  /** Enqueue a task on the serial mutation queue and await its completion. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    // Keep the chain alive even if this task rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /* ---------------------------------------------------------------- */
  /* KVStore                                                           */
  /* ---------------------------------------------------------------- */

  async get<T = unknown>(key: string): Promise<T | null> {
    this.cycleReads++
    this.lifetimeReads++
    await this.ensureLoaded()
    const value = this.cache!.get(key)
    if (value === undefined) return null
    return deepClone(value) as T
  }

  async put(key: string, value: unknown): Promise<void> {
    this.cycleWrites++
    this.lifetimeWrites++
    await this.ensureLoaded()
    this.cache!.set(key, deepClone(value))
    await this.enqueue(() => this.flushLocked())
  }

  async delete(key: string): Promise<void> {
    this.cycleWrites++
    this.lifetimeWrites++
    await this.ensureLoaded()
    const existed = this.cache!.delete(key)
    if (existed) {
      await this.enqueue(() => this.flushLocked())
    }
  }

  async list(prefix = ''): Promise<string[]> {
    this.cycleReads++
    this.lifetimeReads++
    await this.ensureLoaded()
    const keys: string[] = []
    for (const key of this.cache!.keys()) {
      if (key.startsWith(prefix)) keys.push(key)
    }
    keys.sort()
    return keys
  }

  budget(): StorageBudget {
    return {
      reads: this.cycleReads,
      writes: this.cycleWrites,
      lifetimeReads: this.lifetimeReads,
      lifetimeWrites: this.lifetimeWrites,
    }
  }

  resetCycleBudget(): void {
    this.cycleReads = 0
    this.cycleWrites = 0
  }
}
