import { json, jsonError, readJsonBody } from '../../_lib'
import { login } from '@/server/auth/session'

export async function POST(req: Request) {
  const body = await readJsonBody<{ username?: string; password?: string }>(req)
  if (!body?.username || !body?.password) {
    return jsonError('نام کاربری و رمز عبور الزامی است', 400)
  }
  const result = await login(body.username, body.password)
  if (!result.ok) return jsonError(result.error ?? 'ورود ناموفق', 401)
  const res = json({ success: true })
  res.headers.append('Set-Cookie', result.cookie!)
  return res
}
