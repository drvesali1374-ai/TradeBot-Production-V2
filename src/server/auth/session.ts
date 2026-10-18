/**
 * Session auth — signed cookie (HMAC-SHA256), salted password hashing.
 *
 * Improvements over the reference (audit-3 §E):
 *  - No default admin/admin in live deployments: credentials bootstrap
 *    from AUTH_USERNAME/AUTH_PASSWORD env, or the first login sets them
 *    (setup mode) when AUTH_ALLOW_SETUP=1 (dev/demo default).
 *  - Salted SHA-256 (per-credential random salt).
 *  - verify() checks the username still matches stored credentials.
 *  - update-credentials invalidates other sessions (bump issuedAt).
 */
import { createHash, randomBytes } from 'node:crypto'
import { getStorage, STORAGE_KEYS } from '@/server/storage'

const COOKIE_NAME = 'tb_session'
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000

export interface Credentials {
  username: string
  passwordHash: string
  salt: string
  /** bumped on credential change → old cookies invalid */
  issuedAt: number
}

async function sha256Hex(s: string): Promise<string> {
  return createHash('sha256').update(s).digest('hex')
}

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return Buffer.from(sig).toString('hex')
}

function authSecret(): string {
  return process.env.AUTH_SECRET || 'tradebot-dev-secret-local-only'
}

async function loadCredentials(): Promise<Credentials | null> {
  return getStorage().get<Credentials>(STORAGE_KEYS.authCredentials)
}

/** Ensure credentials exist; env-provided or first-login setup (dev). */
async function ensureCredentials(): Promise<Credentials | null> {
  const existing = await loadCredentials()
  if (existing) return existing

  const envUser = process.env.AUTH_USERNAME
  const envPass = process.env.AUTH_PASSWORD
  if (envUser && envPass) {
    const creds = await makeCredentials(envUser, envPass)
    await getStorage().put(STORAGE_KEYS.authCredentials, creds)
    return creds
  }
  return null
}

async function makeCredentials(username: string, password: string): Promise<Credentials> {
  const salt = randomBytes(16).toString('hex')
  const passwordHash = await sha256Hex(`${salt}:${password}`)
  return { username, passwordHash, salt, issuedAt: Date.now() }
}

/* ---------------------------------------------------------------- */
/* Cookie                                                            */
/* ---------------------------------------------------------------- */

export interface SessionPayload {
  username: string
  expiry: number
  issuedAt: number
  signature: string
}

export async function issueSessionCookie(username: string, issuedAt: number): Promise<string> {
  const expiry = Date.now() + SESSION_TTL_MS
  const body = `${username}:${expiry}:${issuedAt}`
  const signature = await hmacHex(body, authSecret())
  const value = `${body}:${signature}`
  return `${COOKIE_NAME}=${value}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`
}

export async function verifySession(cookieHeader: string | null): Promise<SessionPayload | null> {
  if (!cookieHeader) return null
  const cookies = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const idx = c.indexOf('=')
        return idx > 0 ? [c.slice(0, idx), c.slice(idx + 1)] : [c, '']
      })
  )
  const raw = cookies[COOKIE_NAME]
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length !== 4) return null
  const [username, expiryStr, issuedAtStr, signature] = parts
  const expiry = Number(expiryStr)
  const issuedAt = Number(issuedAtStr)
  if (!Number.isFinite(expiry) || !Number.isFinite(issuedAt)) return null
  if (Date.now() > expiry) return null
  const expected = await hmacHex(`${username}:${expiry}:${issuedAt}`, authSecret())
  if (expected !== signature) return null
  // Session must still match current credentials (revocation on change)
  const creds = await ensureCredentials()
  if (!creds || creds.username !== username || creds.issuedAt !== issuedAt) return null
  return { username, expiry, issuedAt, signature }
}

/* ---------------------------------------------------------------- */
/* Login / update                                                    */
/* ---------------------------------------------------------------- */

export async function login(username: string, password: string): Promise<{ ok: boolean; cookie?: string; error?: string }> {
  let creds = await ensureCredentials()
  if (!creds) {
    // Setup mode (dev/demo): first login defines the credentials
    if (process.env.AUTH_ALLOW_SETUP === '1' || !process.env.AUTH_SECRET) {
      creds = await makeCredentials(username, password)
      await getStorage().put(STORAGE_KEYS.authCredentials, creds)
    } else {
      return { ok: false, error: 'اعتبارنامه‌ای تنظیم نشده است' }
    }
  }
  const hash = await sha256Hex(`${creds.salt}:${password}`)
  if (username !== creds.username || hash !== creds.passwordHash) {
    return { ok: false, error: 'نام کاربری یا رمز عبور اشتباه است' }
  }
  return { ok: true, cookie: await issueSessionCookie(username, creds.issuedAt) }
}

export async function updateCredentials(
  currentPassword: string,
  newUsername: string,
  newPassword: string
): Promise<{ ok: boolean; cookie?: string; error?: string }> {
  const creds = await loadCredentials()
  if (!creds) return { ok: false, error: 'هیچ اعتبارنامه‌ای تنظیم نشده است' }
  const hash = await sha256Hex(`${creds.salt}:${currentPassword}`)
  if (hash !== creds.passwordHash) return { ok: false, error: 'رمز عبور فعلی اشتباه است' }
  if (!newUsername || !newPassword) return { ok: false, error: 'نام کاربری و رمز جدید الزامی است' }
  const updated = await makeCredentials(newUsername, newPassword)
  await getStorage().put(STORAGE_KEYS.authCredentials, updated)
  return { ok: true, cookie: await issueSessionCookie(newUsername, updated.issuedAt) }
}

/** Extract username (helper for API routes). */
export async function requireSession(req: Request): Promise<SessionPayload | null> {
  return verifySession(req.headers.get('cookie'))
}
