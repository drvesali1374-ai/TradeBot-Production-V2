import { LocalKVAdapter } from './local-adapter'
import { CloudflareKVAdapter } from './kv-adapter'
import type { KVStore } from './storage-interface'

/**
 * Resolve the storage adapter:
 *  - Cloudflare KV binding when available (production / wrangler dev)
 *  - Local JSON file adapter otherwise (sandbox / fast dev)
 *
 * The singleton lives on globalThis (NOT module scope): Next.js dev can
 * instantiate this module SEPARATELY per API route, and module-scoped
 * singletons produced one adapter per route — writes from one route were
 * invisible to the others until a recompile (the owner-reported «symbols
 * load late / don't show while the data exists» bug). One globalThis slot
 * ⇒ ONE adapter, one cache, one serial write queue for the whole runtime.
 */
const SINGLETON_KEY = '__TRADEBOT_STORAGE__'

export function getStorage(): KVStore {
  const g = globalThis as { [SINGLETON_KEY]?: KVStore }
  if (g[SINGLETON_KEY]) return g[SINGLETON_KEY]
  const adapter = (globalThis as { __TRADING_KV__?: unknown }).__TRADING_KV__
    ? new CloudflareKVAdapter()
    : new LocalKVAdapter()
  g[SINGLETON_KEY] = adapter
  return adapter
}

export { STORAGE_KEYS, LOGS_CAP, PENDING_BALE_CAP } from './storage-interface'
export { WriteBatcher } from './write-batcher'
export type { KVStore, StorageBudget } from './storage-interface'
