import { json } from '../../_lib'
import { clearSessionCookie } from '@/server/auth/session'

export async function POST() {
  const res = json({ success: true })
  res.headers.append('Set-Cookie', clearSessionCookie())
  return res
}
