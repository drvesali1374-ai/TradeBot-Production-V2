'use client'

/**
 * Chart toolbar (RTL) — symbol chips, interval segmented control, live price
 * pill, drawing tools, signal visibility toggle and refresh.
 * Chips reuse `.tool-btn` (theme-aware, incl. dark active color) restyled as
 * pills via inline overrides — no extra CSS classes needed.
 */
import type { CSSProperties } from 'react'
import { fmtPrice } from '@/modules/common/format'
import { INTERVALS, SYMBOLS, type DrawingToolId } from './types'

const sepStyle: CSSProperties = {
  width: 1,
  height: 22,
  background: 'var(--border-color)',
  flexShrink: 0,
}

/** restyles the square `.tool-btn` into a compact pill for symbol chips */
const chipStyle: CSSProperties = {
  width: 'auto',
  height: 'auto',
  padding: '5px 12px',
  borderRadius: 9,
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.3,
}

export interface ChartToolbarProps {
  symbol: string
  onSymbolChange: (symbol: string) => void
  interval: string
  onIntervalChange: (interval: string) => void
  tool: DrawingToolId
  onToolChange: (tool: DrawingToolId) => void
  loading: boolean
  onRefresh: () => void
  /** live ticker price (fallback to last candle close when null) */
  price: number | null
  priceUp: boolean | null
  showSignals: boolean
  onToggleSignals: () => void
  hasDrawings: boolean
  onDeleteDrawing: () => void
  onClearDrawings: () => void
}

interface ToolDef {
  id: DrawingToolId
  icon: string
  label: string
}

const DRAW_TOOLS: ToolDef[] = [
  { id: 'none', icon: 'ph-cursor', label: 'حالت عادی (کراس‌هر)' },
  { id: 'hline', icon: 'ph-minus', label: 'خط افقی' },
  { id: 'vline', icon: 'ph-cursor-text', label: 'خط عمودی' },
  { id: 'trend', icon: 'ph-arrow-up-right', label: 'خط روند' },
  { id: 'rect', icon: 'ph-rectangle', label: 'مستطیل' },
  { id: 'measure', icon: 'ph-ruler', label: 'اندازه‌گیری' },
]

export function ChartToolbar(props: ChartToolbarProps) {
  const {
    symbol, onSymbolChange, interval, onIntervalChange, tool, onToolChange,
    loading, onRefresh, price, priceUp, showSignals, onToggleSignals,
    hasDrawings, onDeleteDrawing, onClearDrawings,
  } = props

  // an external symbol (outside the preset list, e.g. «مشاهده چارت» from
  // another view) is rendered as one extra active chip at the end
  const chips: readonly string[] = SYMBOLS.includes(symbol) ? SYMBOLS : [...SYMBOLS, symbol]

  const priceColor =
    priceUp === true ? 'var(--success)' : priceUp === false ? 'var(--danger)' : 'var(--text-primary)'

  return (
    <div className="chart-toolbar">
      {/* ——— symbol chips ——— */}
      {chips.map((s) => (
        <button
          key={s}
          type="button"
          className={`tool-btn ${s === symbol ? 'active' : ''}`}
          style={chipStyle}
          data-tooltip={`${s} / USDT`}
          aria-label={`نماد ${s}`}
          aria-pressed={s === symbol}
          onClick={() => onSymbolChange(s)}
        >
          <span className="num">{s}</span>
        </button>
      ))}

      <span style={sepStyle} />

      {/* ——— interval ——— */}
      <div className="segmented-control" data-tooltip="بازه زمانی">
        {INTERVALS.map((i) => (
          <button
            key={i}
            type="button"
            className={`seg-tab ${i === interval ? 'active' : ''}`}
            style={{ padding: '5px 12px', fontSize: 12 }}
            onClick={() => onIntervalChange(i)}
          >
            <span className="num">{i}</span>
          </button>
        ))}
      </div>

      <span style={sepStyle} />

      {/* ——— live price ——— */}
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px',
          borderRadius: 10, background: 'var(--bg-hover)', border: '1px solid var(--border-soft)',
        }}
        data-tooltip="قیمت لحظه‌ای — هر ۱۰ ثانیه"
      >
        <i className={`ph ph-pulse ${price != null ? 'pulse-soft' : ''}`} style={{ color: 'var(--success)', fontSize: 15 }} aria-hidden />
        <span className="num" style={{ fontWeight: 800, fontSize: 13.5, color: priceColor, minWidth: 68, textAlign: 'center' }}>
          {price != null ? fmtPrice(price) : '—'}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>USDT</span>
      </span>

      {/* ——— drawing tools (pushed to the far/RTL-left end) ——— */}
      <span style={{ ...sepStyle, marginInlineStart: 'auto' }} />

      {DRAW_TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          data-tooltip={t.label}
          aria-label={t.label}
          onClick={() => onToolChange(t.id)}
        >
          <i className={`ph ${t.icon}`} aria-hidden />
        </button>
      ))}

      <span style={sepStyle} />

      <button
        type="button"
        className="tool-btn"
        data-tooltip="حذف آخرین رسم"
        aria-label="حذف آخرین رسم"
        onClick={onDeleteDrawing}
        disabled={!hasDrawings}
        style={!hasDrawings ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      >
        <i className="ph ph-eraser" aria-hidden />
      </button>
      <button
        type="button"
        className="tool-btn"
        data-tooltip="پاک‌کردن همه رسم‌ها"
        aria-label="پاک‌کردن همه رسم‌ها"
        onClick={onClearDrawings}
        disabled={!hasDrawings}
        style={!hasDrawings ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
      >
        <i className="ph ph-broom" aria-hidden />
      </button>

      <span style={sepStyle} />

      {/* ——— signal legend toggle ——— */}
      <button
        type="button"
        className={`tool-btn ${showSignals ? 'active' : ''}`}
        data-tooltip={showSignals ? 'مخفی‌کردن سیگنال‌ها' : 'نمایش سیگنال‌ها'}
        aria-label={showSignals ? 'مخفی‌کردن سیگنال‌ها' : 'نمایش سیگنال‌ها'}
        onClick={onToggleSignals}
      >
        <i className={`ph ${showSignals ? 'ph-eye' : 'ph-eye-slash'}`} aria-hidden />
      </button>

      {/* ——— refresh ——— */}
      <button
        type="button"
        className="tool-btn"
        data-tooltip="به‌روزرسانی داده‌ها"
        aria-label="به‌روزرسانی داده‌ها"
        onClick={onRefresh}
        disabled={loading}
      >
        <i className={`ph ph-arrows-clockwise ${loading ? 'spin' : ''}`} aria-hidden />
      </button>
    </div>
  )
}
