'use client'

/**
 * Canvas overlay renderer — draws user drawings (lines/rect/measure) onto a
 * 2D canvas positioned over the chart. Pure rendering: callers convert the
 * stored LOGICAL coordinates (bar time + price) into pixels via the chart's
 * own coordinate converters, so shapes track the data on pan/zoom.
 */
import { fmtNum, fmtPct } from '@/modules/common/format'
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
}

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

/** Multi-line RTL tooltip for the measure tool. */
function drawMeasureBox(
  ctx: CanvasRenderingContext2D,
  input: OverlayRenderInput,
  d: DrawingShape,
  x2: number,
  y2: number,
): void {
  const dp = d.price2 - d.price1
  const pct = d.price1 !== 0 ? (dp / Math.abs(d.price1)) * 100 : 0
  const bars = Math.max(1, Math.round((Math.abs(d.time2 - d.time1) * 1000) / Math.max(1, input.intervalMs)))
  const durMs = Math.abs(d.time2 - d.time1) * 1000
  const lines = [
    `Δ ${fmtNum(dp, 2)}`,
    fmtPct(pct),
    `${bars} کندل`,
    `≈ ${fmtDuration(durMs)}`,
  ]

  ctx.save()
  ctx.font = "11px Vazirmatn, 'Segoe UI', sans-serif"
  ctx.direction = 'rtl'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  const padX = 8
  const lineH = 15
  const boxW = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2
  const boxH = lines.length * lineH + 10

  // anchor near the end point, flip sides when close to an edge
  let bx = x2 + 12
  let by = y2 - boxH - 12
  if (bx + boxW > input.w - 4) bx = x2 - boxW - 12
  if (bx < 4) bx = input.w - boxW - 6
  if (by < 4) by = y2 + 14
  if (by + boxH > input.h - 4) by = input.h - boxH - 6

  pathRoundRect(ctx, bx, by, boxW, boxH, 7)
  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)'
  ctx.fill()
  ctx.lineWidth = 1
  ctx.strokeStyle = input.palette.accent
  ctx.stroke()

  ctx.fillStyle = '#e2e8f0'
  lines.forEach((l, i) => {
    ctx.fillText(l, bx + boxW - padX, by + 12 + i * lineH)
  })
  ctx.restore()
}

/** Render one drawing (or draft when input.isPreview) onto the ctx. */
export function renderDrawing(ctx: CanvasRenderingContext2D, input: OverlayRenderInput, d: DrawingShape): void {
  const { palette, w, h, xOfTime, yOfPrice } = input
  ctx.save()
  if (input.isPreview) ctx.globalAlpha = 0.75
  ctx.lineWidth = 1.5
  ctx.strokeStyle = palette.accent
  ctx.fillStyle = palette.accentFill
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
    drawTag(ctx, fmtNum(d.price1, 2), 8, y, palette.accent)
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
    drawTag(ctx, fmtBarTime(d.time1), Math.min(Math.max(x, 30), w - 80), 12, palette.accent)
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

    if (d.type === 'trend') {
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      drawEndpoints(ctx, [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ], palette.accent)
    } else if (d.type === 'rect') {
      const rx = Math.min(x1, x2)
      const ry = Math.min(y1, y2)
      const rw = Math.abs(x2 - x1)
      const rh = Math.abs(y2 - y1)
      pathRoundRect(ctx, rx, ry, rw, rh, 2)
      ctx.fill()
      ctx.stroke()
    } else if (d.type === 'measure') {
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      ctx.stroke()
      ctx.setLineDash([])
      drawEndpoints(ctx, [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ], palette.accent)
      drawMeasureBox(ctx, input, d, x2, y2)
    }
  }
  ctx.restore()
}
