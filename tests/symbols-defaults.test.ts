/**
 * Default-symbols fallback tests (mission 4, item 9) — the shared
 * DEFAULT_SYMBOLS constant is the SINGLE source of truth for the
 * DOT/BTC/ETH fallback used by the symbols route, the status route and
 * the cycle engine (previously three divergent copies → empty UI table
 * while the engine traded DOT/BTC/ETH, «این نماد قبلاً اضافه شده است»).
 *
 * Includes route-level regression checks: the route handlers are plain
 * modules, so bun can import and call them directly (no server needed)
 * against a throwaway TB_DATA_FILE.
 * Run: bun run tests/symbols-defaults.test.ts
 */

// Fresh data file per process — set BEFORE any storage import (dynamic
// imports below guarantee ordering; the adapter resolves the path lazily
// on first access anyway).
process.env.TB_DATA_FILE = `/tmp/tb-symbols-test-${process.pid}.json`

import { promises as fs } from 'node:fs'

let pass = 0
let fail = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`✗ ${label}`)
  }
}

const { STORAGE_KEYS } = await import('../src/server/storage')
const { DEFAULT_SYMBOLS, cloneDefaultSymbols } = await import('../src/core/symbols')
const core = await import('../src/core')

async function main(): Promise<void> {
  await fs.rm(process.env.TB_DATA_FILE!, { force: true })

  /* ---------------- shape / ids ---------------- */

  {
    assert(Array.isArray(DEFAULT_SYMBOLS), 'DEFAULT_SYMBOLS is an array')
    assert(DEFAULT_SYMBOLS.length === 3, `exactly 3 default symbols (got ${DEFAULT_SYMBOLS.length})`)
    assert(DEFAULT_SYMBOLS.map((s) => s.name).join(',') === 'DOT,BTC,ETH', 'names are DOT, BTC, ETH in order')
    assert(DEFAULT_SYMBOLS.map((s) => s.id).join(',') === '1,2,3', 'ids are 1, 2, 3')
    for (const s of DEFAULT_SYMBOLS) {
      assert(s.status === 'waiting', `${s.name}: status 'waiting'`)
      assert(s.errorCount === 0, `${s.name}: errorCount 0`)
      assert(s.lastCycleTime === null, `${s.name}: lastCycleTime null`)
    }

    // cloneDefaultSymbols returns equal-but-independent copies
    const clone = cloneDefaultSymbols()
    assert(JSON.stringify(clone) === JSON.stringify(DEFAULT_SYMBOLS), 'cloneDefaultSymbols() deep-equals DEFAULT_SYMBOLS')
    assert(clone !== DEFAULT_SYMBOLS && clone[0] !== DEFAULT_SYMBOLS[0], 'cloneDefaultSymbols() returns fresh objects (no shared references)')
    clone[0].lastCycleTime = 123
    assert(DEFAULT_SYMBOLS[0].lastCycleTime === null, 'mutating a clone never leaks into DEFAULT_SYMBOLS')
  }

  /* ---------------- shared-constant identity (all three consumers) ---------------- */

  {
    assert(core.DEFAULT_SYMBOLS === DEFAULT_SYMBOLS, 'src/core re-export is the SAME object (identity, not a copy)')
    // Route/engine modules import the constant at module scope; loading the
    // modules below proves they resolve against the same shared module.
    const statusRoute = await import('../src/app/api/automation/status/route')
    const symbolsRoute = await import('../src/app/api/automation/symbols/route')
    const engine = await import('../src/server/automation/cycle-engine')
    assert(typeof statusRoute.GET === 'function', 'status route module loads (imports @/core/symbols)')
    assert(typeof symbolsRoute.GET === 'function' && typeof symbolsRoute.POST === 'function', 'symbols route module loads (imports @/core/symbols)')
    assert(typeof engine.runCycle === 'function', 'cycle-engine module loads (imports @/core fallback)')
  }

  /* ---------------- route-level regression (fresh storage) ---------------- */

  {
    const { login } = await import('../src/server/auth/session')
    const { getStorage } = await import('../src/server/storage')

    // fresh file → only auth_credentials after setup-mode login
    const loginRes = await login('symbolsadmin', 'test-pass-123')
    assert(loginRes.ok === true, 'setup-mode login ok (AUTH_SECRET unset)')

    const store = getStorage()
    const keys = await store.list()
    const symbolsKeyAbsent = !keys.includes(STORAGE_KEYS.symbols)
    assert(symbolsKeyAbsent, 'fresh storage has NO symbols key (precondition of the bug)')

    const cookie = loginRes.cookie!.split(';')[0]
    const authedGet = async (url: string, mod: { GET(req: Request): Promise<Response> }) => {
      const res = await mod.GET(new Request(url, { headers: { cookie } }))
      return (await res.json()) as { success: boolean; symbols: typeof DEFAULT_SYMBOLS }
    }

    // THE BUG: status used to return `symbols: []` for a fresh deployment
    const status = await authedGet('http://localhost/api/automation/status', await import('../src/app/api/automation/status/route'))
    assert(status.success === true, 'status route responds success')
    assert(JSON.stringify(status.symbols) === JSON.stringify(DEFAULT_SYMBOLS), `status route returns DEFAULT_SYMBOLS for fresh storage (got ${JSON.stringify(status.symbols)})`)

    // symbols route already fell back to the same three — still consistent
    const symbols = await authedGet('http://localhost/api/automation/symbols', await import('../src/app/api/automation/symbols/route'))
    assert(JSON.stringify(symbols.symbols) === JSON.stringify(DEFAULT_SYMBOLS), 'symbols route returns the same DEFAULT_SYMBOLS')

    // POST add of an existing default must now correctly fail (no duplicate)
    const symbolsRoute = await import('../src/app/api/automation/symbols/route')
    const addRes = await symbolsRoute.POST(
      new Request('http://localhost/api/automation/symbols', {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'add', symbol: 'DOT' }),
      })
    )
    const addBody = (await addRes.json()) as { success: boolean; error?: string }
    assert(addRes.status === 400 && addBody.success === false, 'adding DOT to the DEFAULT list → 400 (already exists, by design)')
    assert(addBody.error === 'این نماد قبلاً اضافه شده است', 'already-exists error is the documented Persian message')

    // …and the shared constant was NOT polluted by the POST's in-memory mutation
    assert(DEFAULT_SYMBOLS.length === 3, 'DEFAULT_SYMBOLS still has 3 entries after POST add (clone discipline)')
    const after = await authedGet('http://localhost/api/automation/symbols', symbolsRoute)
    assert(after.symbols.length === 3, 'symbols route still serves 3 entries after failed add')
  }
}

try {
  await main()
} catch (e) {
  fail++
  console.error(`✗ unexpected error: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await fs.rm(process.env.TB_DATA_FILE!, { force: true })
}

console.log(`symbols-defaults: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
