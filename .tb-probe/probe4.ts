// READ-ONLY probe round 4: verify TP/SL read-back endpoints (no orders placed)
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
  return { status: res.status, text: await res.text() };
}
function show(tag: string, r: { status: number; text: string }) {
  console.log('\n===== ' + tag + ' → HTTP ' + r.status + ' =====');
  console.log(r.text.slice(0, 2000));
}

await (async () => {
  // v1 read-back: TP/SL conditional orders (type=STOP_PROFIT_LOSS) — all symbols and per-symbol
  show('v1 openOrders type=STOP_PROFIT_LOSS (all)', await signedGet('/api/v1/futures/openOrders', { type: 'STOP_PROFIT_LOSS' }));
  show('v1 openOrders type=STOP (all)', await signedGet('/api/v1/futures/openOrders', { type: 'STOP' }));

  // v2 read-back
  show('v2 open-algo-orders stopCategory=STOP_PROFIT_LOSS (all)', await signedGet('/api/v2/futures/open-algo-orders', { stopCategory: 'STOP_PROFIT_LOSS' }));
  show('v2 open-algo-orders stopCategory=STOP (all)', await signedGet('/api/v2/futures/open-algo-orders', { stopCategory: 'STOP' }));

  // history algo orders (triggered/cancelled TP/SL) — for stats maybe
  show('v2 history-algo-orders stopCategory=STOP_PROFIT_LOSS', await signedGet('/api/v2/futures/history-algo-orders', { stopCategory: 'STOP_PROFIT_LOSS' }));

  // userTrades with limit=200 for a symbol with closed history — check commission + side fields
  const ts = String(Date.now());
  const qs = 'symbol=XRP-SWAP-USDT&limit=5&recvWindow=5000&timestamp=' + ts;
  const res = await fetch('https://api.toobit.com/api/v1/futures/userTrades?' + qs + '&signature=' + hmacHex(qs), { headers: { 'X-BB-APIKEY': API_KEY }, signal: AbortSignal.timeout(12000) });
  show('userTrades XRP limit=5 (manual unsorted qs)', { status: res.status, text: await res.text() });
})();
