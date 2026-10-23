/** Symbol management — add / remove / reorder / clear-errors. Auth required. */
import { json, jsonError, readJsonBody, requireAuth, isResponse } from '../../_lib'
import { getStorage, STORAGE_KEYS } from '@/server/storage'
import { cloneDefaultSymbols } from '@/core/symbols'
import type { SymbolEntry } from '@/core/types'

async function loadSymbols(): Promise<SymbolEntry[]> {
  // Shared DEFAULT_SYMBOLS (same constant the status route + engine use) —
  // cloned because POST mutates the array/entries below.
  const symbols = (await getStorage().get<SymbolEntry[]>(STORAGE_KEYS.symbols)) ?? cloneDefaultSymbols()
  return symbols
}

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  return json({ success: true, symbols: await loadSymbols() })
}

interface SymbolAction {
  action: 'add' | 'remove' | 'reorder' | 'clear-errors'
  symbol?: string
  order?: string[]
}

export async function POST(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const body = await readJsonBody<SymbolAction>(req)
  if (!body?.action) return jsonError('action الزامی است', 400)
  const store = getStorage()
  let symbols = await loadSymbols()

  switch (body.action) {
    case 'add': {
      const name = body.symbol?.trim().toUpperCase()
      if (!name) return jsonError('نام نماد الزامی است', 400)
      if (symbols.some((s) => s.name === name)) return jsonError('این نماد قبلاً اضافه شده است', 400)
      const id = Math.max(0, ...symbols.map((s) => s.id)) + 1
      symbols.push({ id, name, status: 'waiting', errorCount: 0, lastCycleTime: null })
      break
    }
    case 'remove': {
      const name = body.symbol?.trim().toUpperCase()
      if (!name) return jsonError('نام نماد الزامی است', 400)
      symbols = symbols.filter((s) => s.name !== name)
      break
    }
    case 'reorder': {
      if (!Array.isArray(body.order)) return jsonError('order الزامی است', 400)
      const byName = new Map(symbols.map((s) => [s.name, s]))
      const next: SymbolEntry[] = []
      for (const n of body.order) {
        const s = byName.get(n.toUpperCase())
        if (s) {
          next.push(s)
          byName.delete(s.name)
        }
      }
      symbols = [...next, ...byName.values()]
      break
    }
    case 'clear-errors': {
      symbols = symbols.map((s) => ({ ...s, errorCount: 0, status: 'waiting' }))
      break
    }
    default:
      return jsonError('action نامعتبر است', 400)
  }

  await store.put(STORAGE_KEYS.symbols, symbols)
  return json({ success: true, symbols })
}
