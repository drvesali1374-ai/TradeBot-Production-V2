/**
 * Settings model — single reference for defaults and validation.
 *
 * Strategy behavior must be identical across: cycle engine (server),
 * market analysis API and the settings UI. All defaults mirror the
 * audited reference project (audit-2 §C, audit-4 §B.9/B.10).
 */

import type { Signal } from './types'

export const STRATEGY_VERSION = 'v1'

/* ------------------------------------------------------------------ */
/* Automation settings (risk + execution + strategy switches)          */
/* ------------------------------------------------------------------ */

export interface AutomationSettings {
  // Risk management
  safeAssetPercent: number
  maxMarginPerSymbolPercent: number
  signalExpirationHours: number
  minSameDirectionCandles: number
  minPriceDistancePercentLong: number
  minPriceDistancePercentShort: number

  // Execution
  tradeWaitTime: number // minutes
  allowedErrors: number
  cyclesPerRun: number // 1..10
  closedPositionsNotifyCount: number
  leverageLong: number
  leverageShort: number
  entryMarginPercentLong: number
  entryMarginPercentShort: number

  // Market
  interval: '1h' | '30m' | '15m' | '4h' | '1d'
  limit: number // kline count 10..2000
  lookback: number // 10..200

  // Indicators
  htfConfirmationSource: 'signalCandleClose' | 'previousDayClose'
  rsiPeriod: number
  atrPeriod: number
  avgVolPeriod: number
  rsiLongThreshold: number
  rsiShortThreshold: number
  volMultLong: number
  volMultShort: number

  // TP/SL — multipliers are ×ATR, fixed are % of entry (null = ATR-based)
  tpLongMult: number
  slLongMult: number
  tpShortMult: number
  slShortMult: number
  longFixedTp: number | null
  longFixedSl: number | null
  shortFixedTp: number | null
  shortFixedSl: number | null

  // Fake breakout
  enableMeaningfulBreakFilter: boolean
  breakDetectionMethod: 'Wick' | 'Close'
  enableBreakLifecycleManagement: boolean
  breakSequenceLifetime: number // 0 = lookback
  breakAtrMultiplierLong: number
  breakAtrMultiplierShort: number
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  safeAssetPercent: 50,
  maxMarginPerSymbolPercent: 10,
  signalExpirationHours: 6,
  minSameDirectionCandles: 0,
  minPriceDistancePercentLong: 0.5,
  minPriceDistancePercentShort: 0.5,

  tradeWaitTime: 60,
  allowedErrors: 3,
  cyclesPerRun: 1,
  closedPositionsNotifyCount: 10,
  leverageLong: 4,
  leverageShort: 4,
  entryMarginPercentLong: 5,
  entryMarginPercentShort: 5,

  interval: '1h',
  limit: 1000,
  lookback: 50,

  htfConfirmationSource: 'signalCandleClose',
  rsiPeriod: 14,
  atrPeriod: 14,
  avgVolPeriod: 50,
  rsiLongThreshold: 30,
  rsiShortThreshold: 70,
  volMultLong: 0.2,
  volMultShort: 0.2,

  tpLongMult: 20,
  slLongMult: 6,
  tpShortMult: 24,
  slShortMult: 4,
  longFixedTp: null,
  longFixedSl: null,
  shortFixedTp: null,
  shortFixedSl: 6,

  enableMeaningfulBreakFilter: true,
  breakDetectionMethod: 'Wick',
  enableBreakLifecycleManagement: true,
  breakSequenceLifetime: 0,
  breakAtrMultiplierLong: 0.2,
  breakAtrMultiplierShort: 0.2,
}

/* ------------------------------------------------------------------ */
/* Account settings (secrets — stored server-side only)               */
/* ------------------------------------------------------------------ */

export interface AccountSettings {
  apiKey: string
  secretKey: string
  baseUrl: string
  baleToken: string
  baleChatId: string
}

export const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = {
  apiKey: '',
  secretKey: '',
  baseUrl: 'https://api.toobit.com',
  baleToken: '',
  baleChatId: '',
}

/* ------------------------------------------------------------------ */
/* Merge helpers (tolerate partial stored objects)                      */
/* ------------------------------------------------------------------ */

export function mergeAutomationSettings(
  stored: Partial<AutomationSettings> | null | undefined
): AutomationSettings {
  return { ...DEFAULT_AUTOMATION_SETTINGS, ...(stored ?? {}) }
}

export function mergeAccountSettings(
  stored: Partial<AccountSettings> | null | undefined
): AccountSettings {
  return {
    ...DEFAULT_ACCOUNT_SETTINGS,
    ...(stored ?? {}),
    baseUrl: stored?.baseUrl || DEFAULT_ACCOUNT_SETTINGS.baseUrl,
  }
}

/* ------------------------------------------------------------------ */
/* Signal expiration (single source — used by engine + status UI)      */
/* ------------------------------------------------------------------ */

export function isSignalExpired(signal: Signal, settings: AutomationSettings, now = Date.now()): boolean {
  // REFERENCE FIDELITY (mission §6): the reference measures age from the
  // signal candle's OPEN time (signal.timestamp = candle open,
  // automation-manager.js:1189-1197) — not from its close.
  const ageMs = now - signal.candleOpenTime
  return ageMs > settings.signalExpirationHours * 3600_000
}
