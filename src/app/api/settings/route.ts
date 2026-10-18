/**
 * Settings — GET returns sanitized settings (API keys REDACTED, never
 * returned raw); POST validates + saves. Auth required both ways.
 */
import { json, jsonError, readJsonBody, requireAuth, isResponse } from '../_lib'
import {
  loadAutomationSettings,
  loadAccountSettings,
  saveAutomationSettings,
  saveAccountSettings,
  redactAccountSettings,
} from '@/server/configuration/settings-service'
import type { AutomationSettings, AccountSettings } from '@/core/settings'

export async function GET(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const [automation, account] = await Promise.all([loadAutomationSettings(), loadAccountSettings()])
  return json({ success: true, automation, account: redactAccountSettings(account) })
}

interface SettingsBody {
  group: 'automation' | 'account'
  values: Partial<AutomationSettings> & Partial<AccountSettings>
}

export async function POST(req: Request) {
  const session = await requireAuth(req)
  if (isResponse(session)) return session
  const body = await readJsonBody<SettingsBody>(req)
  if (!body?.group || !body.values) return jsonError('group و values الزامی است', 400)

  if (body.group === 'automation') {
    const saved = await saveAutomationSettings(body.values as Partial<AutomationSettings>)
    return json({ success: true, automation: saved })
  }

  // Account: empty apiKey/secretKey means "keep existing" (redacted echo
  // never round-trips real keys). Explicit empty string for bale clears it.
  const v = body.values
  const current = await loadAccountSettings()
  const patch: Partial<AccountSettings> = {
    baleToken: v.baleToken ?? current.baleToken,
    baleChatId: v.baleChatId ?? current.baleChatId,
    baseUrl: current.baseUrl, // fixed allow-list, not client-controlled
  }
  if (typeof v.apiKey === 'string' && v.apiKey && !v.apiKey.includes('••')) patch.apiKey = v.apiKey.trim()
  if (typeof v.secretKey === 'string' && v.secretKey && !v.secretKey.includes('••')) patch.secretKey = v.secretKey.trim()
  const saved = await saveAccountSettings(patch)
  return json({ success: true, account: redactAccountSettings(saved) })
}
