// READ-ONLY probe round 2: find TP/SL read-back endpoint + raw values + pagination
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
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 150); }
  return { status: res.status, body: body, raw: text };
}

function out(tag: string, r: { status: number; body: unknown; raw: string }) {
  const b = r.body;
  let desc = '';
  if (Array.isArray(b)) {
    desc = 'ARRAY len=' + b.length;
    const first = (b as Record<string, unknown>[])[0];
    if (first) desc += ' | first keys: ' + Object.keys(first).join(',');
  } else if (b && typeof b === 'object') {
    desc = 'obj keys: ' + Object.keys(b as Record<string, unknown>).join(',');
  } else {
    desc = String(b).slice(0, 80);
  }
  console.log(tag.padEnd(58) + ' HTTP ' + String(r.status).padEnd(4) + ' ' + desc);
}

async function main() {
  // A) raw open positions (values not secret — needed to confirm profitRate scale + any TP/SL-ish fields)
  const pos = await signedGet('/api/v1/futures/positions', { recvWindow: '5000' });
  console.log('\n== RAW POSITIONS (all, pretty) ==');
  console.log(JSON.stringify(pos.body, null, 1).slice(0, 3000));

  // B) TP/SL endpoint candidates
  const candidates: Array<[string, Record<string, string>]> = [
    ['/api/v1/futures/openOrders', {}],
    ['/api/v1/futures/openOrders', { symbol: 'ETH-SWAP-USDT' }],
    ['/api/v1/futures/stopOrder', {}],
    ['/api/v1/futures/conditionalOrders', {}],
    ['/api/v1/futures/tpslOrders', {}],
    ['/api/v1/futures/position/tpsl', {}],
    ['/api/v1/futures/position/trading-stop', {}],
    ['/api/v1/futures/tradeOrders', {}],
    ['/api/v1/futures/algo/order', {}],
    ['/api/v1/futures/positions/tpsl', {}],
  ];
  console.log('\n== TP/SL ENDPOINT CANDIDATES ==');
  for (const [path, params] of candidates) {
    try { out('GET ' + path + (params.symbol ? ' ?symbol=' + params.symbol : ''), await signedGet(path, params)); }
    catch (e) { console.log(path + ' THREW ' + String(e).slice(0, 60)); }
  }

  // C) historyPositions pagination probe
  console.log('\n== historyPositions PAGINATION ==');
  out('historyPositions (default)', await signedGet('/api/v1/futures/historyPositions', {}));
  out('historyPositions ?pageSize=200', await signedGet('/api/v1/futures/historyPositions', { pageSize: '200' }));
  out('historyPositions ?limit=200', await signedGet('/api/v1/futures/historyPositions', { limit: '200' }));
  const hp = await signedGet('/api/v1/futures/historyPositions', { pageSize: '200' });
  if (Array.isArray(hp.body) && hp.body.length) {
    console.log('sample record (first):');
    console.log(JSON.stringify((hp.body as Record<string, unknown>[])[0], null, 1));
    console.log('closeTime values (first 3):', (hp.body as Record<string, unknown>[]).slice(0, 3).map(r => r['closeTime']).join(', '));
  }

  // D) userTrades for one symbol that HAS closed history (try ETH, SOL, XRP too)
  console.log('\n== userTrades sample (to see commission field) ==');
  for (const sym of ['ETH', 'SOL', 'XRP', 'DOGE', 'BTC']) {
    const ts = String(Date.now());
    const qs = 'symbol=' + sym + '-SWAP-USDT&limit=5&recvWindow=5000&timestamp=' + ts;
    const res = await fetch('https://api.toobit.com/api/v1/futures/userTrades?' + qs + '&signature=' + hmacHex(qs), { headers: { 'X-BB-APIKEY': API_KEY }, signal: AbortSignal.timeout(12000) });
    const text = await res.text();
    let body: unknown; try { body = JSON.parse(text); } catch { body = null; }
    if (Array.isArray(body) && body.length) {
      console.log(sym + ' → len=' + body.length + ' first: ' + JSON.stringify((body as Record<string, unknown>[])[0]));
      break;
    } else {
      console.log(sym + ' → HTTP ' + res.status + ' len=' + (Array.isArray(body) ? body.length : 'non-array'));
    }
  }
}

await main();
