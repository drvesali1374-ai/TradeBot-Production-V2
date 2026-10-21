// READ-ONLY Toobit API probe (GET only — never places/cancels orders)
// Secrets read from /home/z/my-project/.env — never printed.

async function hmacHex(msg: string): Promise<string> {
  const enc = new TextEncoder();
  const SECRET = process.env.TOOBIT_API_SECRET as string;
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
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
  const sig = await hmacHex(qs);
  const url = 'https://api.toobit.com' + path + '?' + qs + '&signature=' + sig;
  const res = await fetch(url, { headers: { 'X-BB-APIKEY': process.env.TOOBIT_API_KEY as string }, signal: AbortSignal.timeout(12000) });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { status: res.status, body: body };
}

function mask(v: unknown): unknown {
  if (typeof v === 'string' && v.length > 24) return v.slice(0, 8) + '…';
  return v;
}

function summarize(tag: string, r: { status: number; body: unknown }) {
  console.log('\n===== ' + tag + ' → HTTP ' + r.status + ' =====');
  const b = r.body;
  if (Array.isArray(b)) {
    console.log('top-level ARRAY, len=' + b.length);
    const first = b[0] as Record<string, unknown> | undefined;
    if (first) {
      console.log('FIRST RECORD keys: ' + Object.keys(first).join(', '));
      console.log('FIRST RECORD: ' + JSON.stringify(first, mask));
    }
  } else if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>;
    console.log('top-level keys: ' + Object.keys(o).join(', '));
    for (const k of ['data', 'result', 'list', 'orders', 'positions']) {
      const v = o[k];
      if (Array.isArray(v)) {
        console.log('.' + k + ' ARRAY len=' + v.length);
        const first = v[0] as Record<string, unknown> | undefined;
        if (first) {
          console.log('.' + k + '[0] keys: ' + Object.keys(first).join(', '));
          console.log('.' + k + '[0]: ' + JSON.stringify(first, mask));
        }
      } else if (v !== undefined) {
        console.log('.' + k + ': ' + JSON.stringify(v, mask).slice(0, 400));
      }
    }
    if (typeof o['code'] === 'number') console.log('.code: ' + o['code'] + ' .errMsg?: ' + String(o['errMsg'] ?? o['msg'] ?? ''));
  } else {
    console.log(String(b).slice(0, 300));
  }
}

async function main() {
  console.log('probe start (keys from env, GET-only)');
  summarize('GET /api/v1/futures/positions', await signedGet('/api/v1/futures/positions', { recvWindow: '5000' }));
  summarize('GET /api/v1/futures/historyPositions', await signedGet('/api/v1/futures/historyPositions', {}));
  summarize('GET /api/v1/futures/stopOrders', await signedGet('/api/v1/futures/stopOrders', {}));
  summarize('GET /api/v1/futures/planOrders', await signedGet('/api/v1/futures/planOrders', {}));
  summarize('GET /api/v1/futures/order (open orders)', await signedGet('/api/v1/futures/order', {}));
  summarize('GET /api/v1/futures/algoOrders', await signedGet('/api/v1/futures/algoOrders', {}));

  // userTrades with reference's manual unsorted query order
  const ts = String(Date.now());
  const qs = 'symbol=BTC-SWAP-USDT&limit=10&recvWindow=5000&timestamp=' + ts;
  const sig = await hmacHex(qs);
  const res = await fetch('https://api.toobit.com/api/v1/futures/userTrades?' + qs + '&signature=' + sig, { headers: { 'X-BB-APIKEY': process.env.TOOBIT_API_KEY as string }, signal: AbortSignal.timeout(12000) });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  summarize('GET /api/v1/futures/userTrades (manual unsorted qs)', { status: res.status, body: body });

  summarize('GET /api/v1/futures/balance', await signedGet('/api/v1/futures/balance', {}));
  console.log('\nprobe done');
}

// load .env into process.env (bun doesn't auto-load for scripts outside project root)
const envText = await Bun.file('/home/z/my-project/.env').text();
for (const line of envText.split('\n')) {
  const eq = line.indexOf('=');
  if (eq > 0) {
    const name = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(name) && !(name in process.env)) process.env[name] = val;
  }
}

main();
