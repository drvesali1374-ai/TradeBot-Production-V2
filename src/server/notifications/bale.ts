/**
 * Bale messenger (Persian messenger notifications).
 *
 * Live: POST https://tapi.bale.ai/bot{token}/sendMessage {chat_id, text}
 * On failure the message is queued (KV `pendingBaleMessages`, cap 50)
 * and flushed on later attempts — the reference mechanism preserved.
 * Queue flush is retried by the cycle engine and the test endpoint.
 */
import { getStorage, STORAGE_KEYS, PENDING_BALE_CAP } from '@/server/storage'

export interface PendingBaleMessage {
  text: string
  token: string
  chatId: string
  timestamp: string
}

export interface BaleConfig {
  baleToken: string
  baleChatId: string
}

export async function sendBale(cfg: BaleConfig, text: string): Promise<{ sent: boolean; queued: boolean }> {
  if (!cfg.baleToken || !cfg.baleChatId) return { sent: false, queued: false }
  try {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(`https://tapi.bale.ai/bot${cfg.baleToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.baleChatId, text }),
      signal: controller.signal,
    })
    clearTimeout(t)
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null
      if (!data || data.ok !== false) return { sent: true, queued: false }
    }
  } catch {
    // network failure → queue
  }
  await queueMessage(cfg, text)
  return { sent: false, queued: true }
}

export async function queueMessage(cfg: BaleConfig, text: string): Promise<void> {
  if (!cfg.baleToken || !cfg.baleChatId) return
  const store = getStorage()
  const queue = (await store.get<PendingBaleMessage[]>(STORAGE_KEYS.pendingBaleMessages)) ?? []
  queue.push({ text, token: cfg.baleToken, chatId: cfg.baleChatId, timestamp: new Date().toISOString() })
  if (queue.length > PENDING_BALE_CAP) queue.splice(0, queue.length - PENDING_BALE_CAP)
  await store.put(STORAGE_KEYS.pendingBaleMessages, queue)
}

/** Try to flush pending messages; returns how many were sent. */
export async function flushPendingBale(): Promise<number> {
  const store = getStorage()
  const queue = (await store.get<PendingBaleMessage[]>(STORAGE_KEYS.pendingBaleMessages)) ?? []
  if (queue.length === 0) return 0
  const remaining: PendingBaleMessage[] = []
  let sent = 0
  for (const msg of queue) {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 8000)
      const res = await fetch(`https://tapi.bale.ai/bot${msg.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: msg.chatId, text: msg.text }),
        signal: controller.signal,
      })
      clearTimeout(t)
      if (res.ok) {
        sent++
      } else {
        remaining.push(msg)
      }
    } catch {
      remaining.push(msg)
    }
  }
  await store.put(STORAGE_KEYS.pendingBaleMessages, remaining)
  return sent
}
