/**
 * Toobit request signing (HMAC-SHA256 via Web Crypto — works on both
 * Node 18+ and Cloudflare Workers).
 *
 * Reference behavior (audit-1 §D):
 *  - buildSortedQuery: keys sorted alphabetically, key AND value
 *    percent-encoded, joined as k=v&k=v
 *  - signature = HMAC-SHA256(sortedQS, secretKey) hex
 *  - Signed GET:  ?{qs}&signature={hex}  + header X-BB-APIKEY
 *  - Signed POST: body = {qs}&signature={hex} as application/x-www-form-urlencoded
 *    + header X-BB-APIKEY
 */

export function buildSortedQuery(params: Record<string, string | number>): string {
  const keys = Object.keys(params).sort()
  return keys
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&')
}

export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export const RECV_WINDOW_DEFAULT = 60_000
export const RECV_WINDOW_POSITIONS = 5_000

export const API_KEY_HEADER = 'X-BB-APIKEY'
