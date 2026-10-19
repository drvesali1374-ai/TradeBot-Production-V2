'use client'

/**
 * Canvas overlay renderer — draws user drawings (lines/rect/measure) onto a
 * 2D canvas positioned over the chart. Pure rendering + hit-testing: callers
 * convert the stored LOGICAL coordinates (bar time + price) into pixels via
 * the chart's own coordinate converters, so shapes track the data on
 * pan/zoom.
 *
 * Editable drawings (2026-10 upgrade):
 *  - every drawing carries an optional user color (fallback: theme accent)
 *  - the selected drawing renders thicker, with a glow and drag handles
 *  - hitTestDrawing() lets the view select/drag anchors (nodes) or the body
 *  - the measure info box renders fully LTR (left-to-right) with Latin
 *    digits — percentage uses the exact TradingView formula:
 *      Δ% = (price2 − price1) / price1 × 100   (signed, base = FIRST point)
 */
import { fmtNum } from '@/modules/common/format'
import type { ChartPalette } from './chartTheme'
import type { Drawing, DrawingDraft } from './types'

/** Anything renderable — a committed drawing or an in-progress draft. */
export type DrawingShape = Drawing | DrawingDraft

export interface OverlayRenderInput {
  /** canvas CSS size (px) */
  w: number
  h: number
  /** logical → pixel converters (return null when impossible) */
  xOfTime: (t: number) => number | null
  yOfPrice: (price: number) => number | null
  palette: ChartPalette
  /** candle duration — used by the measure tool for Δcandles */
  intervalMs: number
  /** draft shapes render dashed & translucent */
  isPreview?: boolean
  /** id of the selected drawing (selection styling + handles) */
  selectedId?: number | null
}

/** What part of a drawing the cursor grabbed. */
export type DrawingHit =
  | { kind: 'handle'; which: AnchorWhich }
  | { kind: 'body' }

/** Identifies a draggable anchor of a drawing. */
export type AnchorWhich = 'p1' | 'p2' | 'tl' | 'tr' | 'bl' | 'br'

/** Human short duration (Persian) for the measure tooltip. */
export function fmtDuration(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 60_000) return `${Math.max(1, Math.round(abs / 60_000))} دقیقه`
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} دقیقه`
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} ساعت`
  return `${Math.round(abs / 86_400_000)} روز`
}

/** Short fa-IR date+time for the vertical-line tag. */
export function fmtBarTime(timeSec: number): string {
  return new Date(timeSec * 1000).toLocaleString('fa-IR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/* ------------------------------------------------------------------ */
/* Color helpers                                                        */
/* ------------------------------------------------------------------ */

function drawingColor(d: DrawingShape, palette: ChartPalette): string {
  const c = (d as Drawing).color
  return c || palette.accent
}

/** `#rrggbb` → `rgba(r,g,b,a)` (fill for rects / halos). Unknown → accent fill. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(99, 102, 241, ${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/* ------------------------------------------------------------------ */
/* Geometry helpers (shared by rendering + hit-testing)                 */
/* ------------------------------------------------------------------ */

interface Anchors {
  /** meaningful anchor pixels (rect exposes 4 corners) */
  points: Array<{ x: number; y: number; which: AnchorWhich }>
  /** two-point line pixels (trend/measure) */
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

function anchorsOf(input: OverlayRenderInput, d: DrawingShape): Anchors | null {
  const { xOfTime, yOfPrice } = input
  if (d.type === 'hline') {
    const y = yOfPrice(d.price1)
    if (y == null) return null
    return { points: [] }
  }
  if (d.type === 'vline') {
    const x = xOfTime(d.time1)
    if (x == null) return null
    return { points: [] }
  }
  const x1 = xOfTime(d.time1)
  const y1 = yOfPrice(d.price1)
  const x2 = xOfTime(d.time2)
  const y2 = yOfPrice(d.price2)
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null
  if (d.type === 'rect') {
    return {
      points: [
        { x: x1, y: y1, which: 'tl' },
        { x: x1, y: y2, which: 'bl' },
        { x: x2, y: y2, which: 'br' },
        { x: x2, y: y1, which: 'tr' },
      ],
      x1,
      y1,
      x2,
      y2,
    }
  }
  return {
    points: [
      { x: x1, y: y1, which: 'p1' },
      { x: x2, y: y2, which: 'p2' },
    ],
    x1,
    y1,
    x2,
    y2,
  }
}

/** Distance from point to segment (px), for line hit-testing. */
function distToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/* ------------------------------------------------------------------ */
/* Hit-testing — used by the view to select & drag drawings             */
/* ------------------------------------------------------------------ */

const HANDLE_R = 9 // grab radius around an anchor handle (px)
const LINE_R = 7 // grab radius around a line/edge (px)

export function hitTestDrawing(
  input: OverlayRenderInput,
  d: Drawing,
  x: number,
  y: number,
): DrawingHit | null {
  const a = anchorsOf(input, d)
  if (!a) return null

  // handles have priority over the body
  for (const pt of a.points) {
    if (Math.hypot(pt.x - x, pt.y - y) <= HANDLE_R) return { kind: 'handle', which: pt.which }
  }

  if (d.type === 'hline') {
    const yLine = input.yOfPrice(d.price1)
    return yLine != null && Math.abs(yLine - y) <= LINE_R ? { kind: 'body' } : null
  }
  if (d.type === 'vline') {
    const xLine = input.xOfTime(d.time1)
    return xLine != null && Math.abs(xLine - x) <= LINE_R ? { kind: 'body' } : null
  }
  const { x1, y1, x2, y2 } = a
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null
  if (d.type === 'rect') {
    const rx = Math.min(x1, x2)
    const ry = Math.min(y1, y2)
    const rw = Math.abs(x2 - x1)
    const rh = Math.abs(y2 - y1)
    const onEdge =
      x >= rx - LINE_R &&
      x <= rx + rw + LINE_R &&
      y >= ry - LINE_R &&
      y <= ry + rh + LINE_R &&
      (Math.abs(x - rx) <= LINE_R ||
        Math.abs(x - (rx + rw)) <= LINE_R ||
        Math.abs(y - ry) <= LINE_R ||
        Math.abs(y - (ry + rh)) <= LINE_R)
    const inside = x > rx && x < rx + rw && y > ry && y < ry + rh
    return onEdge || inside ? { kind: 'body' } : null
  }
  // trend / measure — the measure body is only grabbable along its segment
  if (distToSegment(x, y, x1, y1, x2, y2) <= LINE_R) return { kind: 'body' }
  return null
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function pathRoundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r)
  } else {
    ctx.rect(x, y, w, h)
  }
}

/** Filled tag pill with LTR text (prices / dates). */
function drawTag(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, bg: string): void {
  ctx.save()
  ctx.direction = 'ltr'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = "10.5px Vazirmatn, 'Segoe UI', sans-serif"
  const tw = ctx.measureText(text).width
  const padX = 6
  const boxW = tw + padX * 2
  const boxH = 17
  let bx = x
  let by = y - boxH / 2
  // keep inside canvas
  if (bx + boxW > ctx.canvas.clientWidth) bx = ctx.canvas.clientWidth - boxW - 2
  if (bx < 0) bx = 2
  if (by < 2) by = 2
  pathRoundRect(ctx, bx, by, boxW, boxH, 5)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.fillText(text, bx + padX, by + boxH / 2 + 0.5)
  ctx.restore()
}

function drawHandles(
  ctx: CanvasRenderingContext2D,
  pts: Array<{ x: number; y: number }>,
  color: string,
): void {
  ctx.save()
  for (const pt of pts) {
    // halo
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, 7.5, 0, Math.PI * 2)
    ctx.fillStyle = withAlpha(color, 0.22)
    ctx.fill()
    // knob
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
  ctx.restore()
}

function drawEndpoints(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>, color: string): void {
  ctx.save()
  for (const pt of pts) {
    ctx.beginPath()
    ctx.arc(pt.x, pt.y, 3.5, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#ffffff'
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Measure tooltip — fully LTR (left-to-right), Latin digits, left-aligned.
 * Shows both endpoint prices so the percent is verifiable at a glance:
 *   Δ% = (price2 − price1) / price1 × 100  — the exact TradingView formula.
 */
function drawMeasureBox(
  ctx: CanvasRenderingContext2D,
  input: OverlayRenderInput,
  d: DrawingShape,
  x2: number,
  y2: number,
  color: string,
): void {
  const p1 = d.price1
  const p2 = d.price2
  const dp = p2 - p1
  // TradingView convention: signed percent relative to the FIRST point
  const pct = p1 !== 0 ? (dp / Math.abs(p1)) * 100 : 0
  const bars = Math.max(1, Math.round((Math.abs(d.time2 - d.time1) * 1000) / Math.max(1, input.intervalMs)))
  const durMs = Math.abs(d.time2 - d.time1) * 1000
  const sign = dp >= 0 ? '+' : '-'
  const lines = [
    `From ${fmtNum(p1, 2)}`,
    `To ${fmtNum(p2, 2)}`,
    `Δ ${sign}${fmtNum(Math.abs(dp), 2)}`,
    `Δ% ${sign}${fmtNum(Math.abs(pct), 2)}%`,
    `Bars ${bars}`,
    `Span ${fmtDuration(durMs)}`,
  ]

  ctx.save()
  ctx.direction = 'ltr'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = "10.5px ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace"
  const padX = 8
  const lineH = 14.5
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2
  const boxH = lines.length * lineH + 11

  // anchor near the end point, flip sides when close to an edge
  let bx = x2 + 14
  let by = y2 - boxH - 14
  if (bx + boxW > input.w - 4) bx = x2 - boxW - 14
  if (bx < 4) bx = input.w - boxW - 6
  if (by < 4) by = y2 + 16
  if (by + boxH > input.h - 4) by = input.h - boxH - 6

  pathRoundRect(ctx, bx, by, boxW, boxH, 7)
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)'
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = color
  ctx.stroke()

  lines.forEach((l, i) => {
    // numeric rows (From/To/Δ/Δ%) get accent tinting for readability
    const isDim = i === 4 || i === 5
    ctx.fillStyle = i === 3 ? (dp >= 0 ? '#34d399' : '#f87171') : isDim ? '#94a3b8' : '#e2e8f0'
    ctx.fillText(l, bx + padX, by + 12 + i * lineH)
  })
  ctx.restore()
}

/** Render one drawing (or draft when input.isPreview) onto the ctx. */
export function renderDrawing(ctx: CanvasRenderingContext2D, input: OverlayRenderInput, d: DrawingShape): void {
  const { palette, w, h, xOfTime, yOfPrice, selectedId } = input
  const color = drawingColor(d, palette)
  const selected = selectedId != null && (d as Drawing).id === selectedId

  ctx.save()
  if (input.isPreview) ctx.globalAlpha = 0.75
  ctx.lineWidth = selected ? 2.5 : 1.5
  ctx.strokeStyle = color
  ctx.fillStyle = withAlpha(color, 0.15)
  if (selected) {
    ctx.shadowColor = withAlpha(color, 0.55)
    ctx.shadowBlur = 6
  }
  if (input.isPreview) ctx.setLineDash([6, 4])

  if (d.type === 'hline') {
    const y = yOfPrice(d.price1)
    if (y == null || y < -2 || y > h + 2) {
      ctx.restore()
      return
    }
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    ctx.shadowBlur = 0
    drawTag(ctx, fmtNum(d.price1, 2), 8, y, color)
    if (selected) {
      // grip node mid-line so the level is visibly draggable
      drawHandles(ctx, [{ x: w / 2, y }], color)
    }
  } else if (d.type === 'vline') {
    const x = xOfTime(d.time1)
    if (x == null || x < -2 || x > w + 2) {
      ctx.restore()
      return
    }
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
    ctx.shadowBlur = 0
    drawTag(ctx, fmtBarTime(d.time1), Math.min(Math.max(x, 30), w - 80), 12, color)
    if (selected) {
      drawHandles(ctx, [{ x, y: h / 2 }], color)
    }
  } else {
    // two-point shapes
    const x1 = xOfTime(d.time1)
    const y1 = yOfPrice(d.price1)
    const x2 = xOfTime(d.time2)
    const y2 = yOfPrice(d.price2)
    if (x1 == null || y1 == null || x2 == null || y2 == null) {
      ctx.restore()
      return
    }
    ctx.shadowBlur = 0

    if (d.type === 'trend') {
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      if (selected) {
        drawHandles(ctx, [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ], color)
      } else {
        drawEndpoints(ctx, [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ], color)
      }
    } else if (d.type === 'rect') {
      const rx = Math.min(x1, x2)
      const ry = Math.min(y1, y2)
      const rw = Math.abs(x2 - x1)
      const rh = Math.abs(y2 - y1)
      pathRoundRect(ctx, rx, ry, rw, rh, 2)
      ctx.fill()
      ctx.stroke()
      if (selected) {
        drawHandles(ctx, [
          { x: x1, y: y1 },
          { x: x1, y: y2 },
          { x: x2, y: y2 },
          { x: x2, y: y1 },
        ], color)
      }
    } else if (d.type === 'measure') {
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      ctx.setLineDash([])
      if (selected) {
        drawHandles(ctx, [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ], color)
      } else {
        drawEndpoints(ctx, [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ], color)
      }
      drawMeasureBox(ctx, input, d, x2, y2, color)
    }
  }
  ctx.restore()
}
