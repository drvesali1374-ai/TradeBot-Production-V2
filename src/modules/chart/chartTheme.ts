'use client'

/**
 * Theme bridge — reads the dashboard CSS variables (globals.css) and turns
 * them into lightweight-charts options / canvas overlay colors.
 * Re-read on every theme flip (data-theme attribute on <html>).
 */
import { CrosshairMode, LineStyle, TickMarkType } from 'lightweight-charts'
import type { ChartOptions, DeepPartial, TickMarkFormatter, Time } from 'lightweight-charts'

export interface ChartPalette {
  /** chart pane background (—bg-input) */
  bg: string
  /** axis/labels text */
  text: string
  textMuted: string
  /** grid lines (—border-soft) */
  grid: string
  /** scale borders (—border-color) */
  border: string
  accent: string
  /** rgba fill for drawn rectangles */
  accentFill: string
  success: string
  danger: string
  info: string
}

/** Fixed candle colors (per spec — direction colored, both themes). */
export const UP_COLOR = '#10b981'
export const DOWN_COLOR = '#ef4444'
export const UP_VOLUME = 'rgba(16, 185, 129, 0.4)'
export const DOWN_VOLUME = 'rgba(239, 68, 68, 0.4)'
/** Entry price line (spec: blue solid). */
export const ENTRY_COLOR = '#3b82f6'

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

export function readPalette(): ChartPalette {
  return {
    bg: cssVar('--bg-input', '#ffffff'),
    text: cssVar('--text-secondary', '#475569'),
    textMuted: cssVar('--text-muted', '#94a3b8'),
    grid: cssVar('--border-soft', '#f1f5f9'),
    border: cssVar('--border-color', '#e2e8f0'),
    accent: cssVar('--accent', '#6366f1'),
    accentFill: 'rgba(99, 102, 241, 0.15)',
    success: cssVar('--success', '#10b981'),
    danger: cssVar('--danger', '#ef4444'),
    info: cssVar('--info', '#06b6d4'),
  }
}

/* ------------------------------------------------------------------ */
/* Jalali (Persian calendar) time-axis formatting                      */
/* ------------------------------------------------------------------ */

const jalaliTickFmt = new Intl.DateTimeFormat('fa-IR-u-nu-arabext', {
  calendar: 'persian', timeZone: 'UTC', year: 'numeric', month: 'short', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})

function tickParts(d: Date): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of jalaliTickFmt.formatToParts(d)) out[p.type] = p.value
  return out
}

/**
 * Axis tick labels in the Persian (Jalali) calendar + Persian digits.
 * Time values on the axis are Tehran wall-clock (ChartView shifts data by
 * UTC+03:30 before handing it to lightweight-charts), so they are formatted
 * as UTC to render Tehran local time exactly.
 * NOTE: lightweight-charts v5's TickMarkType is a NUMERIC enum — the
 * with-seconds variant is `TimeWithSeconds` (=4).
 */
const jalaliTickMarkFormatter: TickMarkFormatter = (time, tickMarkType) => {
  const t = time as number
  const d = new Date(t * 1000)
  const p = tickParts(d)
  switch (tickMarkType) {
    case TickMarkType.Year: return p.year ?? ''
    case TickMarkType.Month: return p.month ?? ''
    case TickMarkType.DayOfMonth: return `${p.day} ${p.month}`   // e.g. «۳۱ مهر» — exact Jalali date on the axis
    case TickMarkType.Time: return `${p.hour}:${p.minute}`       // Tehran wall-clock HH:mm
    case TickMarkType.TimeWithSeconds: return `${p.hour}:${p.minute}:${p.second}`
    default: return `${p.day} ${p.month}`
  }
}

/** Chart options derived from the palette (applied on create + theme change). */
export function chartOptionsFor(p: ChartPalette): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { color: p.bg },
      textColor: p.text,
      fontFamily: "'Vazirmatn', 'Segoe UI', sans-serif",
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: p.grid },
      horzLines: { color: p.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: p.accent,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: p.accent,
      },
      horzLine: {
        color: p.accent,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: p.accent,
      },
    },
    rightPriceScale: {
      borderColor: p.border,
      scaleMargins: { top: 0.08, bottom: 0.25 },
    },
    timeScale: {
      borderColor: p.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 5,
      barSpacing: 8,
      tickMarkFormatter: jalaliTickMarkFormatter,
    },
    localization: {
      locale: 'fa-IR',
      // crosshair label — full Jalali date + Tehran time
      timeFormatter: (time: Time) => {
        const d = new Date((time as number) * 1000)
        const p = tickParts(d)
        return `${p.year}/${p.month}/${p.day}، ${p.hour}:${p.minute}:${p.second}`
      },
    },
    handleScale: {
      axisPressedMouseMove: true,
    },
  }
}
