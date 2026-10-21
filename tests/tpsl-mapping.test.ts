/**
 * TP/SL read-back mapping tests (mission §2) — fixtures shaped from the
 * LIVE-VERIFIED Toobit response (mission-3 probe, sanitized — no
 * credentials, no account ids). Run: bun run tests/tpsl-mapping.test.ts
 */
import { buildTpslMap } from '../src/server/exchanges/toobit/client'

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

/** Live row shape (probe 2026-10): STOP_PROFIT_LOSS conditional order. */
const stopRow = (over: Record<string, unknown>) => ({
  time: '1792534212956',
  orderId: '2330340311589556736',
  clientOrderId: 'STOP_SHORT_LOSS_1792534212951',
  symbol: 'XRP-SWAP-USDT',
  price: '0',
  leverage: '4',
  origQty: '0',
  type: 'STOP_PROFIT_LOSS',
  status: 'ORDER_NEW',
  priceType: 'MARKET',
  triggerBy: 'CONTRACT_PRICE',
  ...over,
})
;

// 1) SHORT position: TP + SL both set (live values from probe)
{
  const map = buildTpslMap([
    stopRow({ orderType: 'STOP_SHORT_LOSS', stopPrice: '1.465' }),
    stopRow({ orderType: 'STOP_SHORT_PROFIT', stopPrice: '1.1987' }),
  ])
  const xrp = map.get('XRP-SWAP-USDT|SHORT')
  assert(xrp != null, 'SHORT row exists')
  assert(xrp!.takeProfit === 1.1987, 'SHORT TP = 1.1987')
  assert(xrp!.stopLoss === 1.465, 'SHORT SL = 1.465')
  assert(!map.has('XRP-SWAP-USDT|LONG'), 'not wrongly attached to LONG')
}

// 2) LONG position: TP only (missing SL must stay null)
{
  const map = buildTpslMap([stopRow({ symbol: 'DYDX-SWAP-USDT', orderType: 'STOP_LONG_PROFIT', stopPrice: '0.1182' })])
  const dydx = map.get('DYDX-SWAP-USDT|LONG')
  assert(dydx!.takeProfit === 0.1182, 'LONG TP only')
  assert(dydx!.stopLoss === null, 'missing SL stays null (not zero)')
}

// 3) Canceled rows must be ignored (status filter)
{
  const map = buildTpslMap([
    stopRow({ orderType: 'STOP_SHORT_PROFIT', stopPrice: '9.9', status: 'ORDER_CANCELED' }),
  ])
  assert(!map.has('XRP-SWAP-USDT|SHORT'), 'canceled TP/SL ignored')
}

// 4) Invalid/missing stopPrice rows ignored — never a fabricated 0
{
  const map = buildTpslMap([
    stopRow({ orderType: 'STOP_SHORT_PROFIT', stopPrice: '' }),
    stopRow({ orderType: 'STOP_SHORT_LOSS', stopPrice: 'abc' }),
    stopRow({ orderType: 'STOP_SHORT_PROFIT' }),
  ])
  assert(!map.has('XRP-SWAP-USDT|SHORT'), 'invalid prices ignored')
}

// 5) Multiple rows of same kind → latest wins (overwrite semantics)
{
  const map = buildTpslMap([
    stopRow({ orderType: 'STOP_SHORT_PROFIT', stopPrice: '1.1', time: '100' }),
    stopRow({ orderType: 'STOP_SHORT_PROFIT', stopPrice: '1.2', time: '200' }),
  ])
  assert(map.get('XRP-SWAP-USDT|SHORT')!.takeProfit === 1.2, 'latest TP wins')
}

// 6) Unknown orderType → ignored (no crash, no phantom side)
{
  const map = buildTpslMap([stopRow({ orderType: 'WEIRD_TYPE', stopPrice: '5' })])
  assert(map.size === 0, 'unknown orderType ignored')
}

// 7) Empty list → empty map (position renders «تنظیم نشده» when tpslStatus ok)
{
  assert(buildTpslMap([]).size === 0, 'empty stop list → empty map')
}

console.log(`\nTP/SL mapping: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
