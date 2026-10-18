/**
 * Settings service — load/save with defaults + schema normalization.
 * API keys are stored server-side only; `redact` masks them for the UI.
 */
import type { AutomationSettings, AccountSettings } from '@/core/settings'
import { mergeAutomationSettings, mergeAccountSettings } from '@/core/settings'
import { getStorage, STORAGE_KEYS } from '@/server/storage'

export async function loadAutomationSettings(): Promise<AutomationSettings> {
  const stored = await getStorage().get<Partial<AutomationSettings>>(STORAGE_KEYS.automationSettings)
  return mergeAutomationSettings(stored)
}

export async function loadAccountSettings(): Promise<AccountSettings> {
  const stored = await getStorage().get<Partial<AccountSettings>>(STORAGE_KEYS.accountSettings)
  return mergeAccountSettings(stored)
}

export async function saveAutomationSettings(
  values: Partial<AutomationSettings>
): Promise<AutomationSettings> {
  const current = await loadAutomationSettings()
  const merged = mergeAutomationSettings({ ...current, ...sanitizeAutomation(values) })
  await getStorage().put(STORAGE_KEYS.automationSettings, merged)
  return merged
}

export async function saveAccountSettings(
  values: Partial<AccountSettings>
): Promise<AccountSettings> {
  const current = await loadAccountSettings()
  const merged = mergeAccountSettings({ ...current, ...values })
  await getStorage().put(STORAGE_KEYS.accountSettings, merged)
  return merged
}

/** UI-safe account settings (keys masked). */
export function redactAccountSettings(s: AccountSettings): AccountSettings & { hasApiKey: boolean; hasSecretKey: boolean; hasBale: boolean } {
  return {
    ...s,
    apiKey: s.apiKey ? `${s.apiKey.slice(0, 4)}••••${s.apiKey.slice(-4)}` : '',
    secretKey: s.secretKey ? `${s.secretKey.slice(0, 4)}••••${s.secretKey.slice(-4)}` : '',
    hasApiKey: Boolean(s.apiKey),
    hasSecretKey: Boolean(s.secretKey),
    hasBale: Boolean(s.baleToken && s.baleChatId),
  }
}

function sanitizeAutomation(values: Partial<AutomationSettings>): Partial<AutomationSettings> {
  const out: Partial<AutomationSettings> = {}
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  const keys: (keyof AutomationSettings)[] = [
    'safeAssetPercent', 'maxMarginPerSymbolPercent', 'signalExpirationHours', 'minSameDirectionCandles',
    'minPriceDistancePercentLong', 'minPriceDistancePercentShort', 'tradeWaitTime', 'allowedErrors',
    'cyclesPerRun', 'closedPositionsNotifyCount', 'leverageLong', 'leverageShort',
    'entryMarginPercentLong', 'entryMarginPercentShort', 'limit', 'lookback', 'rsiPeriod',
    'atrPeriod', 'avgVolPeriod', 'rsiLongThreshold', 'rsiShortThreshold', 'volMultLong',
    'volMultShort', 'tpLongMult', 'slLongMult', 'tpShortMult', 'slShortMult',
    'longFixedTp', 'longFixedSl', 'shortFixedTp', 'shortFixedSl',
    'breakSequenceLifetime', 'breakAtrMultiplierLong', 'breakAtrMultiplierShort',
  ]
  for (const k of keys) {
    const v = num((values as Record<string, unknown>)[k])
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  const fixedNullable: (keyof AutomationSettings)[] = ['longFixedTp', 'longFixedSl', 'shortFixedTp', 'shortFixedSl']
  for (const k of fixedNullable) {
    const raw = (values as Record<string, unknown>)[k]
    if (raw === '' || raw === null || raw === undefined) (out as Record<string, unknown>)[k] = null
  }
  if (values.interval && ['1h', '30m', '15m', '4h', '1d'].includes(values.interval)) out.interval = values.interval
  if (values.htfConfirmationSource && ['signalCandleClose', 'previousDayClose'].includes(values.htfConfirmationSource)) {
    out.htfConfirmationSource = values.htfConfirmationSource
  }
  if (typeof values.breakDetectionMethod === 'string' && ['Wick', 'Close'].includes(values.breakDetectionMethod)) {
    out.breakDetectionMethod = values.breakDetectionMethod
  }
  if (typeof values.enableMeaningfulBreakFilter === 'boolean') out.enableMeaningfulBreakFilter = values.enableMeaningfulBreakFilter
  if (typeof values.enableBreakLifecycleManagement === 'boolean') out.enableBreakLifecycleManagement = values.enableBreakLifecycleManagement
  return out
}
