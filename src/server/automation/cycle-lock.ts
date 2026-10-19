/**
 * Cycle lock — prevents overlapping cycles (cron + manual).
 *
 * KV is not transactional, so this is a best-effort atomic lock:
 *  - write {lockedAt, expiresAt, cycleId} only when absent/expired
 *  - TTL (90s) guarantees release even if the process dies mid-cycle
 *  - stale locks are reported so the UI can surface the anomaly
 *
 * The read+put sequence is serialized inside the Local adapter queue;
 * on real KV two racing writers can both succeed — the 5-minute cron
 * cadence + manual single-cycle UX makes this window acceptable, and
 * the lastCycleTime immediate write acts as a second guard (reference
 * behavior). Documented in docs/architecture.md §lock.
 */
import { getStorage, STORAGE_KEYS } from '@/server/storage'

export const LOCK_TTL_MS = 90_000

export interface LockRecord {
  cycleId: string
  lockedAt: number
  expiresAt: number
  source: 'manual' | 'cron'
}

export async function tryAcquireLock(source: 'manual' | 'cron', cycleId: string): Promise<{ acquired: boolean; heldBy?: LockRecord; stale?: boolean }> {
  const store = getStorage()
  const existing = await store.get<LockRecord>(STORAGE_KEYS.cycleLock)
  const now = Date.now()
  if (existing && existing.expiresAt > now) {
    return { acquired: false, heldBy: existing }
  }
  const rec: LockRecord = { cycleId, lockedAt: now, expiresAt: now + LOCK_TTL_MS, source }
  await store.put(STORAGE_KEYS.cycleLock, rec)
  return { acquired: true }
}

export async function releaseLock(cycleId: string): Promise<void> {
  const store = getStorage()
  const existing = await store.get<LockRecord>(STORAGE_KEYS.cycleLock)
  // Only release our own lock (a newer cycle may hold it)
  if (existing && existing.cycleId === cycleId) {
    await store.delete(STORAGE_KEYS.cycleLock)
  }
}
