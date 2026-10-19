/**
 * API helpers — auth guard + standard JSON responses.
 * All sensitive routes call `requireAuth` first.
 */
import { requireSession } from '@/server/auth/session'
import type { SessionPayload } from '@/server/auth/session'

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export function jsonError(message: string, status = 400, extra: Record<string, unknown> = {}): Response {
  return Response.json({ success: false, error: message, ...extra }, { status })
}

export async function requireAuth(req: Request): Promise<SessionPayload | Response> {
  const session = await requireSession(req)
  if (!session) return jsonError('احراز هویت نشده است', 401)
  return session
}

export function isResponse(v: unknown): v is Response {
  return v instanceof Response
}

export async function readJsonBody<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}
