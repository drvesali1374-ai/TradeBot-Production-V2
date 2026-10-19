import { LocalKVAdapter } from './local-adapter'
import { CloudflareKVAdapter } from './kv-adapter'
import type { KVStore } from './storage-interface'

let singleton: KVStore | null = null

/**
 * Resolve the storage adapter:
 *  - Cloudflare KV binding when available (production / wrangler dev)
 *  - Local JSON file adapter otherwise (sandbox / fast dev)
 * Single shared instance per process.
 */
export function getStorage(): KVStore {
  if (singleton) return singleton
  singleton = (globalThis as { __TRADING_KV__?: unknown }).__TRADING_KV__
    ? new CloudflareKVAdapter()
    : new LocalKVAdapter()
  return singleton
}

export { STORAGE_KEYS, LOGS_CAP, PENDING_BALE_CAP } from './storage-interface'
export { WriteBatcher } from './write-batcher'
export type { KVStore, StorageBudget } from './storage-interface'
