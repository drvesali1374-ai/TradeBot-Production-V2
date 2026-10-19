import { json } from '../../_lib'
import { requireSession } from '@/server/auth/session'

export async function GET(req: Request) {
  const session = await requireSession(req)
  if (!session) return json({ authenticated: false }, 401)
  return json({ authenticated: true, username: session.username })
}
