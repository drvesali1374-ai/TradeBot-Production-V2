'use client'

/**
 * Formatting helpers — Persian-friendly, LTR-numeric displays.
 */

export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function fmtPrice(n: number | null | undefined): string {
  return fmtNum(n, 2)
}

export function fmtUsd(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n < 0 ? '−' : ''
  // money amounts keep a stable 2-decimal presentation ($12.50, not $12.5)
  const abs = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  })
  return `${sign}$${abs}`
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || Number.isNaN(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}${fmtNum(Math.abs(n), digits)}٪`
}

export function fmtTime(ts: number | string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function fmtDateTime(ts: number | string | null | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return d.toLocaleDateString('fa-IR', { month: '2-digit', day: '2-digit' }) + '، ' +
    d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })
}

export function fmtAgo(ts: number | string | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60_000) return 'چند لحظه پیش'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} دقیقه پیش`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ساعت پیش`
  return `${Math.floor(diff / 86_400_000)} روز پیش`
}

export function fmtQty(n: number | null | undefined): string {
  return fmtNum(n, 0)
}

export function pnlColor(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return 'var(--text-muted)'
  return n > 0 ? 'var(--success)' : n < 0 ? 'var(--danger)' : 'var(--text-muted)'
}

export function shortSymbol(full: string): string {
  return full.replace(/-SWAP-USDT$/i, '')
}
