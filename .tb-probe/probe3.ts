// READ-ONLY probe round 3: trading-stop GET read-back + order history endpoints
import * as crypto from 'node:crypto';

const envText = await Bun.file('/home/z/my-project/.env').text();
for (const line of envText.split('\n')) {
  const eq = line.indexOf('=');
  if (eq > 0) {
    const name = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(name) && !(name in process.env)) process.env[name] = val;
  }
}
const SECRET = process.env.TOOBIT_API_SECRET as string;
const API_KEY = process.env.TOOBIT_API_KEY as string;

function hmacHex(msg: string): string {
  return crypto.createHmac('sha256', SECRET).update(msg).digest('hex');
}
function sortedQS(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  const parts: string[] = [];
  for (const k of keys) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  return parts.join('&');
}
async function signedGet(path: string, params: Record<string, string>) {
  const all: Record<string, string> = {};
  for (const k in params) all[k] = params[k];
  if (!('recvWindow' in all)) all['recvWindow'] = '60000';
  all['timestamp'] = String(Date.now());
  const qs = sortedQS(all);
  const url = 'https://api.toobit.com' + path + '?' + qs + '&signature=' + hmacHex(qs);
  const res = await fetch(url, { headers: { 'X-BB-APIKEY': API_KEY }, signal: AbortSignal.timeout(12000) });
  const text = await res.text();
  return { status: res.status, text: text };
}
function show(tag: string, r: { status: number; text: string }) {
  console.log('\n===== ' + tag + ' → HTTP ' + r.status + ' =====');
  console.log(r.text.slice(0, 1200));
}

await (async () => {
  // 1) trading-stop GET with symbol (position TP/SL read-back?)
  show('GET /api/v1/futures/position/trading-stop?symbol=DYDX-SWAP-USDT', await signedGet('/api/v1/futures/position/trading-stop', { symbol: 'DYDX-SWAP-USDT' }));
  show('GET /api/v1/futures/position/trading-stop?symbol=DOT-SWAP-USDT', await signedGet('/api/v1/futures/position/trading-stop', { symbol: 'DOT-SWAP-USDT' }));

  // 2) orders list / history endpoints
  show('GET /api/v1/futures/orders?symbol=DYDX-SWAP-USDT', await signedGet('/api/v1/futures/orders', { symbol: 'DYDX-SWAP-USDT' }));
  show('GET /api/v1/futures/orderHistory?symbol=DYDX-SWAP-USDT', await signedGet('/api/v1/futures/orderHistory', { symbol: 'DYDX-SWAP-USDT' }));
  show('GET /api/v1/futures/historyOrders?symbol=DYDX-SWAP-USDT', await signedGet('/api/v1/futures/historyOrders', { symbol: 'DYDX-SWAP-USDT' }));
})();
