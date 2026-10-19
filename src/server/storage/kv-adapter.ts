/**
 * Cloudflare KV adapter — production binding.
 *
 * Used when running on Cloudflare with the TRADING_DATA KV namespace.
 * Detection is lazy so the module stays importable in Node.
 */
import type { KVStore, StorageBudget } from './storage-interface'

interface KVNamespaceLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(options?: { prefix?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>
}

declare global {
  var __TRADING_KV__: KVNamespaceLike | undefined
}

export class CloudflareKVAdapter implements KVStore {
  private ns(): KVNamespaceLike {
    const ns = globalThis.__TRADING_KV__
    if (!ns) throw new Error('Cloudflare KV binding TRADING_DATA unavailable')
    return ns
  }

  private cycleReads = 0
  private cycleWrites = 0
  private lifetimeReads = 0
  private lifetimeWrites = 0

  async get<T = unknown>(key: string): Promise<T | null> {
    this.cycleReads++
    this.lifetimeReads++
    const raw = await this.ns().get(key)
    if (raw == null) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as unknown as T
    }
  }

  async put(key: string, value: unknown): Promise<void> {
    this.cycleWrites++
    this.lifetimeWrites++
    await this.ns().put(key, JSON.stringify(value))
  }

  async delete(key: string): Promise<void> {
    this.cycleWrites++
    this.lifetimeWrites++
    await this.ns().delete(key)
  }

  async list(prefix = ''): Promise<string[]> {
    this.cycleReads++
    this.lifetimeReads++
    const res = await this.ns().list({ prefix })
    return res.keys.map((k) => k.name)
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
