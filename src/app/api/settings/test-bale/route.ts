/** Test Bale notification + flush pending queue. */
import { json, jsonError, readJsonBody, requireAuth, isResponse } from '../../_lib'
import { loadAccountSettings } from '@/server/configuration/settings-service'
import { sendBale, flushPendingBale } from '@/server/notifications/bale'

export async function POST(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const account = await loadAccountSettings()
  if (!account.baleToken || !account.baleChatId) {
    return jsonError('توکن بله و شناسه چت تنظیم نشده است', 400)
  }
  const body = await readJsonBody<{ text?: string }>(req)
  const text = body?.text || `🤖 پیام آزمایشی تریدبات — ${new Date().toISOString()}`
  const res = await sendBale({ baleToken: account.baleToken, baleChatId: account.baleChatId }, text)
  const flushed = await flushPendingBale()
  return json({
    success: res.sent,
    sent: res.sent,
    queued: res.queued,
    flushed,
    message: res.sent ? 'پیام آزمایشی ارسال شد' : 'ارسال ناموفق — پیام در صف قرار گرفت',
  })
}
