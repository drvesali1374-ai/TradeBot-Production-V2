'use client'

/**
 * Chart toolbar (RTL) — symbol chips (+ user-defined custom symbols),
 * interval segmented control, live price pill, drawing tools, signal
 * visibility toggle and refresh.
 * Chips reuse `.tool-btn` (theme-aware, incl. dark active color) restyled as
 * pills via inline overrides — no extra CSS classes needed.
 */
import { useRef, useState, type CSSProperties } from 'react'
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
  /** user-added custom symbols (persisted by the view) */
  customSymbols: readonly string[]
  onAddSymbol: (symbol: string) => void
  onRemoveSymbol: (symbol: string) => void
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

const CUSTOM_SYMBOL_RE = /^[A-Z0-9]{2,16}$/

export function ChartToolbar(props: ChartToolbarProps) {
  const {
    symbol, onSymbolChange, interval, onIntervalChange, tool, onToolChange,
    loading, onRefresh, price, priceUp, showSignals, onToggleSignals,
    hasDrawings, onDeleteDrawing, onClearDrawings,
    customSymbols, onAddSymbol, onRemoveSymbol,
  } = props

  /* ——— custom symbol add input ——— */
  const [adding, setAdding] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  const submitCustom = () => {
    const s = value.trim().toUpperCase()
    if (CUSTOM_SYMBOL_RE.test(s)) {
      onAddSymbol(s)
      setValue('')
      setAdding(false)
    } else {
      inputRef.current?.focus() // keep typing — invalid so far
    }
  }

  // chips = presets + customs; an external symbol outside both lists still
  // renders as one extra active chip (e.g. «مشاهده چارت» from another view)
  const known = [...SYMBOLS, ...customSymbols]
  const chips: readonly string[] = known.includes(symbol) ? known : [...known, symbol]

  const isCustom = (s: string) => !SYMBOLS.includes(s) && customSymbols.includes(s)

  const priceColor =
    priceUp === true ? 'var(--success)' : priceUp === false ? 'var(--danger)' : 'var(--text-primary)'

  return (
    <div className="chart-toolbar">
      {/* ——— symbol chips (preset + user-defined) ——— */}
      {chips.map((s) => (
        <span key={s} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
          <button
            type="button"
            className={`tool-btn ${s === symbol ? 'active' : ''}`}
            style={{ ...chipStyle, ...(isCustom(s) ? { borderStyle: 'dashed' } : null) }}
            data-tooltip={isCustom(s) ? `${s} / USDT — نماد دلخواه شما` : `${s} / USDT`}
            aria-label={`نماد ${s}`}
            aria-pressed={s === symbol}
            onClick={() => onSymbolChange(s)}
          >
            <span className="num">{s}</span>
          </button>
          {isCustom(s) ? (
            <button
              type="button"
              className="tool-btn"
              style={{ width: 17, height: 17, borderRadius: '50%', fontSize: 11, marginLeft: -7, marginRight: 2, border: 'none', background: 'var(--bg-hover)', color: 'var(--danger)', zIndex: 1 }}
              data-tooltip={`حذف ${s} از فهرست نمادها`}
              aria-label={`حذف نماد ${s}`}
              onClick={() => onRemoveSymbol(s)}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}

      {/* ——— add custom symbol ——— */}
      {adding ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <input
            ref={inputRef}
            autoFocus
            dir="ltr"
            value={value}
            onChange={(e) => setValue(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitCustom()
              if (e.key === 'Escape') {
                setValue('')
                setAdding(false)
              }
            }}
            placeholder="SYMBOL"
            aria-label="نام نماد جدید (مثل LTC)"
            style={{
              width: 96, height: 30, padding: '0 9px', borderRadius: 9,
              border: '1px solid var(--accent)', background: 'var(--bg-input)',
              color: 'var(--text-primary)', fontSize: 12, fontWeight: 700,
              fontFamily: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
              outline: 'none', letterSpacing: 0.5,
            }}
          />
          <button
            type="button"
            className="tool-btn"
            style={{ width: 28, height: 28, fontSize: 14, color: 'var(--success)' }}
            data-tooltip="افزودن نماد"
            aria-label="افزودن نماد"
            onClick={submitCustom}
          >
            <i className="ph ph-check" aria-hidden />
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="tool-btn"
          style={{ width: 28, height: 28, fontSize: 15 }}
          data-tooltip="افزودن نماد دلخواه (هر نماد توبیت)"
          aria-label="افزودن نماد دلخواه"
          onClick={() => setAdding(true)}
        >
          <i className="ph ph-plus" aria-hidden />
        </button>
      )}

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
