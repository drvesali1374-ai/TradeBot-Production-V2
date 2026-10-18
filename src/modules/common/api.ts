'use client'

/**
 * API client — all requests relative paths, credentials included.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', cache: 'no-store' })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status })
  }
  return data as T
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status })
  }
  return data as T
}

export function isAuthError(e: unknown): boolean {
  return e instanceof Error && 'status' in e && (e as { status?: number }).status === 401
}
