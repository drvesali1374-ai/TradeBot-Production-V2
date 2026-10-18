import { json, jsonError, readJsonBody, requireAuth, isResponse } from '../../_lib'
import { updateCredentials } from '@/server/auth/session'

export async function POST(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const body = await readJsonBody<{ currentPassword?: string; newUsername?: string; newPassword?: string }>(req)
  if (!body?.currentPassword || !body?.newUsername || !body?.newPassword) {
    return jsonError('همه فیلدها الزامی است', 400)
  }
  const result = await updateCredentials(body.currentPassword, body.newUsername, body.newPassword)
  if (!result.ok) return jsonError(result.error ?? 'به‌روزرسانی ناموفق', 400)
  const res = json({ success: true })
  res.headers.append('Set-Cookie', result.cookie!)
  return res
}
