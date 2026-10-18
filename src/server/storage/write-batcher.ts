/**
 * Write batcher — persists only actually-changed values.
 *
 * Implements instruction §4.3: before writing, compare with a stable
 * deep-equality check (structural, not reference) and skip unchanged
 * data. `persist()` returns the number of writes performed.
 */
import type { KVStore } from './storage-interface'

export function stableEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export class WriteBatcher {
  private originals = new Map<string, unknown>()
  private staged = new Map<string, unknown>()
  private deletions = new Set<string>()

  constructor(private store: KVStore) {}

  /** Track a key's current value (one read) so later writes compare. */
  track(key: string, value: unknown): void {
    if (!this.originals.has(key)) this.originals.set(key, value)
  }

  /** Stage a new value for a key (no write yet). */
  stage(key: string, value: unknown): void {
    this.staged.set(key, value)
    this.deletions.delete(key)
  }

  /** Stage a deletion. */
  stageDelete(key: string): void {
    this.deletions.add(key)
    this.staged.delete(key)
  }

  /** Flush: write only real changes. Returns count of writes performed. */
  async persist(): Promise<number> {
    let writes = 0
    for (const [key, value] of this.staged) {
      const original = this.originals.get(key)
      if (original === undefined) {
        // Unknown original → write only if a value exists to store
        if (value !== null && value !== undefined) {
          await this.store.put(key, value)
          writes++
        }
        continue
      }
      if (!stableEquals(original, value)) {
        await this.store.put(key, value)
        writes++
      }
    }
    for (const key of this.deletions) {
      await this.store.delete(key)
      writes++
    }
    this.staged.clear()
    this.deletions.clear()
    this.originals.clear()
    return writes
  }
}
