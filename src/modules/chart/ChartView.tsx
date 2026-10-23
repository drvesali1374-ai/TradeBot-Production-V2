'use client'

/**
 * ChartView — professional trading chart (lightweight-charts v5).
 *
 * • Candlestick + volume histogram (volume on its own bottom-scaled axis)
 * • Signal markers + TP/SL/Entry price lines from /api/market/analysis
 * • Canvas drawing overlay (hline/vline/trend/rect/measure) using LOGICAL
 *   coordinates (bar-time + price) so drawings track the data on pan/zoom
 * • Crosshair OHLCV+RSI readout, live ticker price (10s), theme-aware
 *   (re-reads CSS variables when data-theme flips), fully RTL layout.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import {
  CandlestickSeries,
  HistogramSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import type {
  IChartApi,
  IPriceLine,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  MouseEventParams,
  SeriesMarker,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import { apiGet } from '@/modules/common/api'
import { fmtDateTime, fmtNum, fmtPrice } from '@/modules/common/format'
import { useToast } from '@/modules/common/toast'
import { ChartToolbar } from './ChartToolbar'
import {
  ENTRY_COLOR,
  DOWN_COLOR,
  DOWN_VOLUME,
  UP_COLOR,
  UP_VOLUME,
  chartOptionsFor,
  readPalette,
} from './chartTheme'
import { renderDrawing, hitTestDrawing, type AnchorWhich, type DrawingHit, type OverlayRenderInput } from './drawingRender'
import {
  DRAW_COLORS,
  INTERVALS,
  INTERVAL_MS,
  SYMBOLS,
  type AnalysisResponse,
  type Candle,
  type ChartFocusPayload,
  type Drawing,
  type DrawingDraft,
  type DrawingToolId,
  type KlinesResponse,
  type Signal,
  type SignalStatus,
  type TickerResponse,
} from './types'

/* ------------------------------------------------------------------ */
/* Props                                                               */
/* ------------------------------------------------------------------ */

export interface ChartViewProps {
  initialSymbol: string
  /** §7 — initial toolbar interval (page restores it from the URL) */
  initialInterval?: string
  /** §7 — signal-candle focus: center + mark the bar containing signalTime */
  focus?: ChartFocusPayload | null
  onSymbolChange?: (symbol: string) => void
  onIntervalChange?: (interval: string) => void
  /** fired when the focus should be dropped (back-to-now button) */
  onFocusDrop?: () => void
}

interface SignalState {
  signals: Signal[]
  pending: Signal | null
  /** interval the analysis engine actually used (may differ from chart) */
  analysisInterval: string | null
}

const SIGNAL_STATUS_META: Record<SignalStatus, { label: string; cls: string }> = {
  PENDING: { label: 'در انتظار', cls: 'badge-warning' },
  OPENED: { label: 'باز شد', cls: 'badge-success' },
  EXPIRED: { label: 'منقضی', cls: 'badge-danger' },
  NOT_OPENED: { label: 'باز نشد', cls: 'badge-info' },
}

/**
 * Greatest bar open-time (UNIX seconds) at-or-before targetMs.
 * Snapping keeps markers placeable even when the analysis interval differs
 * from the chart interval (larger intervals align to smaller boundaries).
 */
function snapBarTimeSec(candles: Candle[], targetMs: number, intervalMs: number): number | null {
  if (candles.length === 0) return null
  const first = candles[0]
  const last = candles[candles.length - 1]
  if (targetMs < first.openTime - intervalMs) return null
  if (targetMs > last.openTime + intervalMs) return null
  let lo = 0
  let hi = candles.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].openTime <= targetMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return Math.floor(candles[ans].openTime / 1000)
}

/**
 * Focus lookup (mission §7.2) — ms-CONSISTENT companion of snapBarTimeSec.
 * ALL inputs/outputs are epoch MILLISECONDS (Toobit kline row[0] is ms;
 * Signal.candleOpenTime is ms; lightweight-charts Time is SECONDS and is
 * derived only at chart-API boundaries).
 *
 * Returns the index of the bar CONTAINING targetMs (openTime ≤ targetMs <
 * openTime+intervalMs), or -1 when targetMs lies before the window / in a
 * data gap / beyond the last bar. An EXACT candleOpenTime always matches
 * when the bar exists in `candles`.
 */
function barIndexForMs(candles: Candle[], targetMs: number, intervalMs: number): number {
  const n = candles.length
  if (n === 0) return -1
  if (targetMs < candles[0].openTime) return -1
  if (targetMs > candles[n - 1].openTime + intervalMs) return -1
  let lo = 0
  let hi = n - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (candles[mid].openTime <= targetMs) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  const bar = candles[ans]
  // exact/mid-gap containment: only a bar whose [open, open+interval) span
  // covers the target is the signal's candle — never a wrong neighbor.
  return targetMs < bar.openTime + intervalMs ? ans : -1
}

/** Active drawing-drag session. */
interface DragState {
  id: number
  kind: DrawingHit['kind']
  which?: AnchorWhich
  /** logical anchors under the grab point at drag start */
  startT: number
  startP: number
  /** pre-drag copy for Esc-cancel */
  snapshot: Drawing
}

const CUSTOM_SYMBOLS_KEY = 'tradebot.chart.customSymbols'
const CUSTOM_SYMBOL_RE = /^[A-Z0-9]{2,16}$/

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/** Consumed focus — resolved after the data load (for badge/legend + E2E). */
interface FocusInfo {
  /** bar open-time in SECONDS (lightweight-charts Time unit) */
  barTimeSec: number
  signal: ChartFocusPayload
}

export function ChartView({ initialSymbol, initialInterval, focus, onSymbolChange, onIntervalChange, onFocusDrop }: ChartViewProps) {
  const { show } = useToast()

  /* ——— state ——— */
  const [symbol, setSymbol] = useState(initialSymbol || 'BTC')
  const [interval, setInterval] = useState(
    initialInterval && (INTERVALS as readonly string[]).includes(initialInterval) ? initialInterval : '1h',
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [priceUp, setPriceUp] = useState<boolean | null>(null)
  const [lastClose, setLastClose] = useState<number | null>(null)
  const [showSignals, setShowSignals] = useState(true)
  const [tool, setTool] = useState<DrawingToolId>('none')
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [hoverCandle, setHoverCandle] = useState<Candle | null>(null)
  const [signalState, setSignalState] = useState<SignalState | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [customSymbols, setCustomSymbols] = useState<string[]>([])
  // §7 — the consumed focus (chart centered + marker drawn). Null while no
  // focus is active or when the focus bar could not be found in the data.
  const [focusInfo, setFocusInfo] = useState<FocusInfo | null>(null)
  // m4 (item 4) — panel-driven focus: clicking a row in the in-chart
  // «سیگنال‌های اخیر» list centers the chart on that signal WITHOUT a page
  // remount (unlike the §7 shell flow the component stays mounted, so the
  // payload lives here and the data-load effect is re-triggered via
  // reloadKey / the interval state change).
  const [localFocus, setLocalFocus] = useState<ChartFocusPayload | null>(null)

  /* ——— refs (imperative chart world) ——— */
  const containerRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLCanvasElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const markersApiRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const priceLinesRef = useRef<IPriceLine[]>([])
  const candlesRef = useRef<Candle[]>([])
  const candlesByTimeRef = useRef<Map<number, Candle>>(new Map())
  const rsiByTimeRef = useRef<Map<number, number>>(new Map())
  const analysisRef = useRef<AnalysisResponse | null>(null)
  const signalsVisibleRef = useRef(true)
  const intervalMsRef = useRef<number>(INTERVAL_MS[interval] ?? 3_600_000)
  const draftRef = useRef<DrawingDraft | null>(null)
  const drawingsRef = useRef<Drawing[]>([])
  const drawingsRevRef = useRef(0)
  const loadIdRef = useRef(0)
  const symbolRef = useRef(symbol)
  const intervalRef = useRef(interval)
  const nextIdRef = useRef(1)
  const onSymbolChangeRef = useRef(onSymbolChange)
  const onIntervalChangeRef = useRef(onIntervalChange)
  const onFocusDropRef = useRef(onFocusDrop)
  const prevTickRef = useRef<number | null>(null)
  const selectedIdRef = useRef<number | null>(null)
  const lastColorRef = useRef<string | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  // §7 focus world: prop mirror + resolved visual state + marker snapshot
  const focusRef = useRef<ChartFocusPayload | null>(focus ?? null)
  const focusActiveRef = useRef(false)
  const focusBarSecRef = useRef<number | null>(null)
  const focusInfoRef = useRef<FocusInfo | null>(null)
  const lastMarkersRef = useRef<SeriesMarker<Time>[]>([])

  useEffect(() => {
    focusInfoRef.current = focusInfo
  }, [focusInfo])

  useEffect(() => {
    onSymbolChangeRef.current = onSymbolChange
  }, [onSymbolChange])

  useEffect(() => {
    onIntervalChangeRef.current = onIntervalChange
  }, [onIntervalChange])

  useEffect(() => {
    onFocusDropRef.current = onFocusDrop
  }, [onFocusDrop])

  /* ---------------------------------------------------------------- */
  /* Overlay rendering (logical → pixel on every chart redraw)        */
  /* ---------------------------------------------------------------- */

  const buildOverlayInput = useCallback((): OverlayRenderInput | null => {
    const canvas = overlayRef.current
    const chart = chartRef.current
    const series = candleRef.current
    if (!canvas || !chart || !series) return null
    const ts = chart.timeScale()
    return {
      w: canvas.clientWidth,
      h: canvas.clientHeight,
      xOfTime: (t) => ts.timeToCoordinate(t as UTCTimestamp),
      yOfPrice: (p) => series.priceToCoordinate(p),
      palette: readPalette(),
      intervalMs: intervalMsRef.current,
      selectedId: selectedIdRef.current,
    }
  }, [])

  const redrawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const input = buildOverlayInput()
    if (!canvas || !input) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { w, h } = input
    if (w < 2 || h < 2) return

    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(w * dpr)
    const ph = Math.round(h * dpr)
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw
      canvas.height = ph
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    for (const d of drawingsRef.current) renderDrawing(ctx, input, d)
    const draft = draftRef.current
    if (draft) renderDrawing(ctx, { ...input, isPreview: true }, draft)
  }, [buildOverlayInput])

  /**
   * Wrap-relative (x,y) → logical anchors (bar time + price). With `magnet`,
   * the price snaps to the hovered candle's high/low wick when within ~8px —
   * TradingView-style precision so wick-tip measurements register the exact
   * wick price instead of a few-pixels-off value.
   */
  const pointAt = useCallback(
    (x: number, y: number, magnet: boolean): { t: number | null; price: number | null } => {
      const chart = chartRef.current
      const series = candleRef.current
      if (!chart || !series) return { t: null, price: null }
      const tRaw = chart.timeScale().coordinateToTime(x)
      const t = typeof tRaw === 'number' ? tRaw : null
      let price: number | null = series.coordinateToPrice(y)
      if (magnet && t != null) {
        const c = candlesByTimeRef.current.get(t)
        if (c && price != null) {
          for (const wick of [c.high, c.low]) {
            const wy = series.priceToCoordinate(wick)
            if (wy != null && Math.abs(wy - y) <= 8) {
              price = wick
              break
            }
          }
        }
      }
      return { t, price }
    },
    [],
  )

  /**
   * Signature of everything that affects overlay geometry (visible logical
   * range, price mapping of the last close, canvas size, drawings revision,
   * draft position). A rAF watchdog compares it every frame — this catches
   * price-axis drags & auto-rescales which have no dedicated event.
   */
  const overlaySignature = useCallback(() => {
    const chart = chartRef.current
    const series = candleRef.current
    const canvas = overlayRef.current
    if (!chart || !series || !canvas) return 'no'
    const lr = chart.timeScale().getVisibleLogicalRange()
    const last = candlesRef.current.length ? candlesRef.current[candlesRef.current.length - 1] : null
    const y = last ? series.priceToCoordinate(last.close) : null
    const x = last ? chart.timeScale().timeToCoordinate((last.openTime / 1000) as UTCTimestamp) : null
    const draft = draftRef.current
    return [
      canvas.clientWidth,
      canvas.clientHeight,
      lr ? `${lr.from.toFixed(2)}:${lr.to.toFixed(2)}` : '-',
      y != null ? y.toFixed(1) : '-',
      x != null ? x.toFixed(1) : '-',
      drawingsRevRef.current,
      draft ? `${draft.time2}:${draft.price2}` : '-',
    ].join('|')
  }, [])

  /* ---------------------------------------------------------------- */
  /* Chart lifecycle (create once, theme/resize observers, cleanup)   */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, {
      ...chartOptionsFor(readPalette()),
      width: container.clientWidth,
      height: container.clientHeight,
    })
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderUpColor: UP_COLOR,
      borderDownColor: DOWN_COLOR,
    })
    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
    const markersApi = createSeriesMarkers(candleSeries, [])

    chartRef.current = chart
    candleRef.current = candleSeries
    volumeRef.current = volumeSeries
    markersApiRef.current = markersApi

    // crosshair → OHLCV/RSI readout (last candle when not hovering)
    const onCrosshair = (param: MouseEventParams<Time>) => {
      const t = param.time
      let next: Candle | null = null
      if (typeof t === 'number') next = candlesByTimeRef.current.get(t) ?? null
      if (!next) {
        const cs = candlesRef.current
        next = cs.length ? cs[cs.length - 1] : null
      }
      if (next) setHoverCandle((prev) => (prev && prev.openTime === next!.openTime ? prev : next))
    }
    chart.subscribeCrosshairMove(onCrosshair)

    // redraw overlay on pan/zoom
    const onRange = () => redrawOverlay()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)

    // responsive size
    const onResize = () => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight })
      redrawOverlay()
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(container)

    // theme flips → re-apply chart options + overlay colors
    const applyTheme = () => {
      chart.applyOptions(chartOptionsFor(readPalette()))
      redrawOverlay()
    }
    const mo = new MutationObserver(applyTheme)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    // rAF watchdog — redraw the overlay whenever the visual mapping changed
    let raf = 0
    let lastSig = ''
    const tick = () => {
      const sig = overlaySignature()
      if (sig !== lastSig) {
        lastSig = sig
        redrawOverlay()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
      markersApi.detach()
      chart.remove()
      chartRef.current = null
      candleRef.current = null
      volumeRef.current = null
      markersApiRef.current = null
    }
  }, [redrawOverlay, overlaySignature])

  /* ---------------------------------------------------------------- */
  /* Markers & price lines                                             */
  /* ---------------------------------------------------------------- */

  const refreshMarkers = useCallback(() => {
    const api = markersApiRef.current
    if (!api) return
    const an = analysisRef.current
    const candles = candlesRef.current
    const list: SeriesMarker<Time>[] = []
    if (an && signalsVisibleRef.current && candles.length > 0) {
      const intervalMs = intervalMsRef.current
      const pendingId = an.pendingSignal?.id
      const seen = new Set<string>()
      for (const s of an.signals ?? []) {
        if (seen.has(s.id)) continue
        seen.add(s.id)
        const t = snapBarTimeSec(candles, s.candleOpenTime, intervalMs)
        if (t == null) continue
        const isPending = pendingId != null && s.id === pendingId
        const isLong = s.side === 'Long'
        list.push({
          time: t as UTCTimestamp,
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? UP_COLOR : DOWN_COLOR,
          shape: isLong ? 'arrowUp' : 'arrowDown',
          text: isPending ? (isLong ? 'L · در انتظار' : 'S · در انتظار') : isLong ? 'L' : 'S',
          size: isPending ? 2 : 1,
        })
      }
    }
    // §7.2 — the focused signal MUST show a marker at its bar even when the
    // analysis window/payload does not include it (e.g. historical focus):
    // synthesize one from the focus payload, deduped by bar time.
    if (focusActiveRef.current && focusBarSecRef.current != null && signalsVisibleRef.current) {
      const t = focusBarSecRef.current as UTCTimestamp
      if (!list.some((m) => (m.time as number) === (t as number))) {
        const isLong = focusRef.current?.side !== 'Short'
        list.push({
          time: t,
          position: isLong ? 'belowBar' : 'aboveBar',
          color: isLong ? UP_COLOR : DOWN_COLOR,
          shape: isLong ? 'arrowUp' : 'arrowDown',
          text: isLong ? 'L · سیگنال' : 'S · سیگنال',
          size: 2,
        })
      }
    }
    list.sort((a, b) => (a.time as number) - (b.time as number))
    lastMarkersRef.current = list
    api.setMarkers(list)
  }, [])

  /** Entry/TP/SL price lines — generalized (§7.2): the FOCUSED signal gets
   *  them while a focus is active; without a focus the pending signal keeps
   *  its previous behavior. Cleared whenever the focus drops. */
  const refreshPriceLines = useCallback(() => {
    const series = candleRef.current
    if (!series) return
    for (const line of priceLinesRef.current) {
      try {
        series.removePriceLine(line)
      } catch {
        /* already detached */
      }
    }
    priceLinesRef.current = []
    let target: { price: number; tp: number; sl: number } | null = null
    if (signalsVisibleRef.current) {
      if (focusActiveRef.current && focusRef.current) {
        const f = focusRef.current
        if (Number.isFinite(f.price) && Number.isFinite(f.tp) && Number.isFinite(f.sl)) {
          target = { price: f.price as number, tp: f.tp as number, sl: f.sl as number }
        }
      } else {
        const pending = analysisRef.current?.pendingSignal
        if (pending) target = { price: pending.price, tp: pending.tp, sl: pending.sl }
      }
    }
    if (!target) return
    const mk = (price: number, color: string, style: LineStyle, title: string): IPriceLine =>
      series.createPriceLine({
        price,
        color,
        lineStyle: style,
        lineWidth: 1,
        title,
        axisLabelVisible: true,
      })
    priceLinesRef.current = [
      mk(target.price, ENTRY_COLOR, LineStyle.Solid, 'Entry'),
      mk(target.tp, UP_COLOR, LineStyle.Dashed, 'TP'),
      mk(target.sl, DOWN_COLOR, LineStyle.Dashed, 'SL'),
    ]
  }, [])

  /* ---------------------------------------------------------------- */
  /* Data application                                                  */
  /* ---------------------------------------------------------------- */

  const applyKlines = useCallback(
    (candles: Candle[], focusIdx = -1) => {
      candlesRef.current = candles
      candlesByTimeRef.current = new Map(candles.map((c) => [Math.floor(c.openTime / 1000), c]))
      const series = candleRef.current
      const vol = volumeRef.current
      if (series && vol) {
        series.setData(
          candles.map((c) => ({
            time: Math.floor(c.openTime / 1000) as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        )
        vol.setData(
          candles.map((c) => ({
            time: Math.floor(c.openTime / 1000) as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? UP_VOLUME : DOWN_VOLUME,
          })),
        )
        const n = candles.length
        const ts = chartRef.current?.timeScale()
        const focusSignal = focusRef.current
        if (focusIdx >= 0 && focusSignal && candles[focusIdx]) {
          // §7.2 — center ON the signal's candle (replaces the default
          // last-130 centering) and activate the focus visuals.
          const barSec = Math.floor(candles[focusIdx].openTime / 1000)
          focusBarSecRef.current = barSec
          focusActiveRef.current = true
          setFocusInfo({ barTimeSec: barSec, signal: focusSignal })
          ts?.setVisibleLogicalRange({
            from: Math.max(0, focusIdx - 80),
            to: focusIdx + 40,
          })
        } else {
          // no focus (or focus NOT resolved — §7.2 forbids wrong movement):
          // focus the last ~130 candles as before.
          focusBarSecRef.current = null
          focusActiveRef.current = false
          setFocusInfo(null)
          ts?.setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 6 })
        }
      }
      setHoverCandle(candles.length ? candles[candles.length - 1] : null)
      setLastClose(candles.length ? candles[candles.length - 1].close : null)
      refreshMarkers()
      refreshPriceLines()
      redrawOverlay()
    },
    [refreshMarkers, refreshPriceLines, redrawOverlay],
  )

  const applyAnalysis = useCallback(
    (an: AnalysisResponse | null) => {
      analysisRef.current = an
      const rsiMap = new Map<number, number>()
      if (an) {
        for (const c of an.candles ?? []) {
          if (c.rsi != null) rsiMap.set(Math.floor(c.openTime / 1000), c.rsi)
        }
      }
      rsiByTimeRef.current = rsiMap
      setSignalState(
        an
          ? { signals: an.signals ?? [], pending: an.pendingSignal ?? null, analysisInterval: an.interval ?? null }
          : null,
      )
      refreshMarkers()
      refreshPriceLines()
      redrawOverlay()
    },
    [refreshMarkers, refreshPriceLines, redrawOverlay],
  )

  /* ---------------------------------------------------------------- */
  /* §7 focus — prop mirror. Declared BEFORE the data-load effect so the */
  /* refs are already up to date in the same commit (effect order).     */
  /* ---------------------------------------------------------------- */

  // m4 — a FRESH page-level focus (§7 shell navigation) always wins over a
  // panel-driven local focus. The page shell rebuilds its focus payload
  // object on EVERY render (new identity), so compare by VALUE key
  // (signalTime+id+side): identity churn (e.g. a toast re-rendering the
  // shell) must NOT wipe an active local focus.
  const focusPropKey = focus ? `${focus.signalTime}:${focus.signalId ?? ''}:${focus.side ?? ''}` : null
  const prevFocusPropKeyRef = useRef<string | null>(focusPropKey)
  useEffect(() => {
    if (focusPropKey && focusPropKey !== prevFocusPropKeyRef.current) setLocalFocus(null)
    prevFocusPropKeyRef.current = focusPropKey
  }, [focusPropKey])

  useEffect(() => {
    // m4 — a panel-clicked LOCAL focus shadows the prop focus (the prop
    // focus cleared the local one in the effect above when it arrived).
    focusRef.current = localFocus ?? focus ?? null
    if (!focusRef.current) {
      // focus dropped (manual symbol/interval change or back-to-now):
      // immediately remove the focus visuals — marker/price lines/badge.
      focusActiveRef.current = false
      focusBarSecRef.current = null
      setFocusInfo(null)
      refreshMarkers()
      refreshPriceLines()
    }
  }, [focus, localFocus, refreshMarkers, refreshPriceLines])

  /* ---------------------------------------------------------------- */
  /* Data loading (klines → analysis → markers/price-lines → redraw)  */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const myId = ++loadIdRef.current
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const kl = await apiGet<KlinesResponse>(
          `/api/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=500`,
        )
        if (cancelled || myId !== loadIdRef.current) return
        let candles = (kl.candles ?? []).slice().sort((a, b) => a.openTime - b.openTime)
        if (candles.length === 0) throw new Error('کندلی برای این نماد یافت نشد')
        const intervalMs = INTERVAL_MS[interval] ?? 3_600_000
        const focusSignal = focusRef.current
        let focusIdx = focusSignal ? barIndexForMs(candles, focusSignal.signalTime, intervalMs) : -1
        // §7.2 step 4 — the signal candle predates the latest window: fetch a
        // history window COVERING it (end-anchored: Toobit returns the newest
        // `limit` candles inside [start,end], so anchor endTime ≈ focus + 250
        // intervals to land the focus bar mid-window) and center there.
        if (focusSignal && focusIdx === -1) {
          try {
            const half = Math.floor(500 / 2)
            const startTime = focusSignal.signalTime - half * intervalMs
            const endTime = focusSignal.signalTime + half * intervalMs
            const k2 = await apiGet<KlinesResponse>(
              `/api/market/klines?symbol=${encodeURIComponent(symbol)}` +
                `&interval=${interval}&limit=500&startTime=${startTime}&endTime=${endTime}`,
            )
            if (cancelled || myId !== loadIdRef.current) return
            const hist = (k2.candles ?? []).slice().sort((a, b) => a.openTime - b.openTime)
            const hIdx = hist.length ? barIndexForMs(hist, focusSignal.signalTime, intervalMs) : -1
            if (hIdx !== -1) {
              candles = hist
              focusIdx = hIdx
            }
          } catch {
            /* historical fetch failed — fall through to the not-found path */
          }
        }
        if (cancelled || myId !== loadIdRef.current) return
        if (focusSignal && focusIdx === -1) {
          // §7.2 step 5 — CLEAR message; do NOT move the chart anywhere else.
          show('سیگنال در چارت', 'سیگنال در داده تاریخی موجود یافت نشد', 'warning')
        }
        applyKlines(candles, focusIdx)
        // analysis is secondary — its failure must not blank the candles
        try {
          const an = await apiGet<AnalysisResponse>(`/api/market/analysis?symbol=${encodeURIComponent(symbol)}`)
          if (cancelled || myId !== loadIdRef.current) return
          applyAnalysis(an)
        } catch {
          if (!cancelled && myId === loadIdRef.current) applyAnalysis(null)
        }
      } catch (e) {
        if (cancelled || myId !== loadIdRef.current) return
        applyAnalysis(null)
        setError(e instanceof Error ? e.message : 'خطا در دریافت داده‌های بازار')
      } finally {
        if (!cancelled && myId === loadIdRef.current) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [symbol, interval, reloadKey, applyKlines, applyAnalysis, show])

  /* ---------------------------------------------------------------- */
  /* Live ticker (10s polling)                                         */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    let alive = true
    prevTickRef.current = null
    setPriceUp(null)
    const fetchOnce = async () => {
      try {
        const r = await apiGet<TickerResponse>(`/api/market/ticker?symbol=${encodeURIComponent(symbol)}`)
        if (!alive) return
        if (typeof r.price === 'number' && Number.isFinite(r.price)) {
          if (prevTickRef.current != null) setPriceUp(r.price > prevTickRef.current)
          prevTickRef.current = r.price
          setLivePrice(r.price)
        }
      } catch {
        /* silent — the pill falls back to the last candle close */
      }
    }
    void fetchOnce()
    const id = window.setInterval(fetchOnce, 10_000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [symbol])

  /* ---------------------------------------------------------------- */
  /* State ↔ refs sync                                                 */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    symbolRef.current = symbol
  }, [symbol])

  useEffect(() => {
    intervalRef.current = interval
    intervalMsRef.current = INTERVAL_MS[interval] ?? 3_600_000
  }, [interval])

  useEffect(() => {
    drawingsRef.current = drawings
    drawingsRevRef.current++
    redrawOverlay()
  }, [drawings, redrawOverlay])

  useEffect(() => {
    signalsVisibleRef.current = showSignals
    refreshMarkers()
    refreshPriceLines()
  }, [showSignals, refreshMarkers, refreshPriceLines])

  // external symbol changes (e.g. «مشاهده چارت» from other views)
  useEffect(() => {
    const s = initialSymbol?.trim()
    if (s && s !== symbolRef.current) {
      symbolRef.current = s
      setSymbol(s)
    }
  }, [initialSymbol])

  // external interval changes (§7 — page restores the interval from the
  // URL / goToSignal before the chart view mounts)
  useEffect(() => {
    const i = initialInterval?.trim()
    if (i && (INTERVALS as readonly string[]).includes(i) && i !== intervalRef.current) {
      intervalRef.current = i
      setInterval(i)
    }
  }, [initialInterval])

  /* ---------------------------------------------------------------- */
  /* Drawing interactions                                              */
  /* ---------------------------------------------------------------- */

  const pushDrawing = useCallback((d: Omit<Drawing, 'id'>) => {
    setDrawings((prev) => [...prev, { ...d, id: nextIdRef.current++ }])
  }, [])

  const onOverlayClick = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const chart = chartRef.current
      const series = candleRef.current
      if (!chart || !series || candlesRef.current.length === 0) return
      if (tool === 'none') return // selection handled at the wrap level
      const x = e.nativeEvent.offsetX
      const y = e.nativeEvent.offsetY

      if (tool === 'hline') {
        const { price } = pointAt(x, y, true)
        if (price == null) return
        pushDrawing({
          type: 'hline', price1: price, time1: 0, price2: price, time2: 0,
          color: lastColorRef.current ?? undefined,
        })
        setTool('none')
      } else if (tool === 'vline') {
        const { t } = pointAt(x, y, false)
        if (t == null) return
        pushDrawing({
          type: 'vline', time1: t, price1: 0, time2: t, price2: 0,
          color: lastColorRef.current ?? undefined,
        })
        setTool('none')
      } else if (tool === 'trend' || tool === 'rect' || tool === 'measure') {
        const { t, price } = pointAt(x, y, true)
        const draft = draftRef.current
        if (!draft) {
          if (price == null || t == null) return
          draftRef.current = { type: tool, time1: t, price1: price, time2: t, price2: price }
        } else {
          if (price == null || t == null) return
          const { type, time1, price1 } = draft
          draftRef.current = null
          pushDrawing({
            type, time1, price1, time2: t, price2: price,
            color: lastColorRef.current ?? undefined,
          })
          setTool('none')
        }
      }
      redrawOverlay()
    },
    [tool, pushDrawing, redrawOverlay, pointAt],
  )

  const onOverlayMove = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const draft = draftRef.current
      if (!draft) return
      const { t, price } = pointAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY, true)
      if (price != null) draft.price2 = price
      if (t != null) draft.time2 = t
      redrawOverlay()
    },
    [redrawOverlay, pointAt],
  )

  /* ---------------------------------------------------------------- */
  /* Selection & editing (tool === 'none')                             */
  /* ---------------------------------------------------------------- */

  // always-fresh indirection so window listeners stay stable per drag
  const dragMoveRef = useRef<(ev: PointerEvent) => void>(() => {})
  const dragUpRef = useRef<(ev: PointerEvent) => void>(() => {})
  const moveProxy = useCallback((ev: PointerEvent) => dragMoveRef.current(ev), [])
  const upProxy = useCallback((ev: PointerEvent) => dragUpRef.current(ev), [])

  const endDrag = useCallback(
    (cancel: boolean) => {
      const drag = dragRef.current
      dragRef.current = null
      window.removeEventListener('pointermove', moveProxy)
      window.removeEventListener('pointerup', upProxy)
      const wrap = wrapRef.current
      if (wrap) {
        wrap.style.cursor = ''
        delete wrap.dataset.dhover
      }
      if (!drag) return
      if (cancel) {
        const target = drawingsRef.current.find((d) => d.id === drag.id)
        if (target) Object.assign(target, drag.snapshot)
        drawingsRevRef.current++
        redrawOverlay()
      }
      setDrawings([...drawingsRef.current])
    },
    [moveProxy, upProxy, redrawOverlay],
  )

  const onDragMove = useCallback(
    (ev: PointerEvent) => {
      const drag = dragRef.current
      const wrap = wrapRef.current
      const input = buildOverlayInput()
      if (!drag || !wrap || !input) return
      const rect = wrap.getBoundingClientRect()
      const { t, price } = pointAt(
        ev.clientX - rect.left,
        ev.clientY - rect.top,
        drag.kind === 'handle', // magnet while dragging a node, raw for body moves
      )
      if (t == null && price == null) return
      const target = drawingsRef.current.find((d) => d.id === drag.id)
      if (!target) return
      const snap = drag.snapshot
      const curT = t ?? drag.startT
      const curP = price ?? drag.startP
      if (drag.kind === 'handle' && drag.which) {
        switch (drag.which) {
          case 'p1':
          case 'tl':
            target.time1 = curT
            target.price1 = curP
            break
          case 'p2':
          case 'br':
            target.time2 = curT
            target.price2 = curP
            break
          case 'bl':
            target.time1 = curT
            target.price2 = curP
            break
          case 'tr':
            target.time2 = curT
            target.price1 = curP
            break
        }
      } else if (target.type === 'hline') {
        const dp = curP - drag.startP
        target.price1 = snap.price1 + dp
        target.price2 = snap.price1 + dp
      } else if (target.type === 'vline') {
        const dt = curT - drag.startT
        target.time1 = snap.time1 + dt
        target.time2 = snap.time1 + dt
      } else {
        const dt = curT - drag.startT
        const dp = curP - drag.startP
        target.time1 = snap.time1 + dt
        target.time2 = snap.time2 + dt
        target.price1 = snap.price1 + dp
        target.price2 = snap.price2 + dp
      }
      drawingsRevRef.current++
      redrawOverlay()
    },
    [buildOverlayInput, pointAt, redrawOverlay],
  )

  const onDragUp = useCallback(
    () => {
      endDrag(false)
    },
    [endDrag],
  )

  useEffect(() => {
    dragMoveRef.current = onDragMove
    dragUpRef.current = onDragUp
  }, [onDragMove, onDragUp])

  const onWrapPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (tool !== 'none' || !wrapRef.current) return
      // clicks on in-chart UI (editor popover) never hit-test drawings
      const el = e.target as HTMLElement | null
      if (el && typeof el.closest === 'function' && el.closest('[data-chart-ui]')) return
      const rect = wrapRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const input = buildOverlayInput()
      if (!input) return
      const list = drawingsRef.current
      for (let i = list.length - 1; i >= 0; i--) {
        const hit = hitTestDrawing(input, list[i], x, y)
        if (hit) {
          // block the chart's own pointer handlers (pan) for this gesture
          e.stopPropagation()
          e.preventDefault()
          selectedIdRef.current = list[i].id
          setSelectedId(list[i].id)
          const { t, price } = pointAt(x, y, hit.kind === 'handle')
          dragRef.current = {
            id: list[i].id,
            kind: hit.kind,
            which: hit.kind === 'handle' ? hit.which : undefined,
            startT: t ?? list[i].time1,
            startP: price ?? list[i].price1,
            snapshot: { ...list[i] },
          }
          wrapRef.current.dataset.dhover = 'drag'
          window.addEventListener('pointermove', moveProxy)
          window.addEventListener('pointerup', upProxy)
          return
        }
      }
      // empty spot → deselect
      if (selectedIdRef.current != null) {
        selectedIdRef.current = null
        setSelectedId(null)
      }
    },
    [tool, buildOverlayInput, pointAt, moveProxy, upProxy],
  )

  const onWrapMouseMove = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      const wrap = wrapRef.current
      if (!wrap) return
      if (tool !== 'none' || dragRef.current) return
      const rect = wrap.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const input = buildOverlayInput()
      if (!input) {
        delete wrap.dataset.dhover
        return
      }
      const list = drawingsRef.current
      let hover: 'handle' | 'body' | '' = ''
      for (let i = list.length - 1; i >= 0; i--) {
        const hit = hitTestDrawing(input, list[i], x, y)
        if (hit) {
          hover = hit.kind === 'handle' ? 'handle' : 'body'
          break
        }
      }
      if (hover) wrap.dataset.dhover = hover
      else delete wrap.dataset.dhover
    },
    [tool, buildOverlayInput],
  )

  const applySelectedColor = useCallback((c: string) => {
    const id = selectedIdRef.current
    if (id == null) return
    lastColorRef.current = c
    setDrawings((prev) => prev.map((d) => (d.id === id ? { ...d, color: c } : d)))
  }, [])

  const deleteSelected = useCallback(() => {
    const id = selectedIdRef.current
    if (id == null) return
    selectedIdRef.current = null
    setSelectedId(null)
    setDrawings((prev) => prev.filter((d) => d.id !== id))
  }, [])

  // selection → overlay styling refresh
  useEffect(() => {
    selectedIdRef.current = selectedId
    drawingsRevRef.current++
    redrawOverlay()
  }, [selectedId, redrawOverlay])

  // dev-only debug/E2E hook — exposes chart coordinate accessors (no secrets).
  // §7 E2E additions: visibleRange (SECONDS, from/to), visibleLogicalRange,
  // the applied markers list and the consumed focus info.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return
    const w = window as unknown as { __tbChart?: Record<string, unknown> }
    w.__tbChart = {
      priceToCoordinate: (p: number) => candleRef.current?.priceToCoordinate(p) ?? null,
      coordinateToPrice: (y: number) => candleRef.current?.coordinateToPrice(y) ?? null,
      timeToCoordinate: (t: number) =>
        chartRef.current?.timeScale().timeToCoordinate(t as UTCTimestamp) ?? null,
      coordinateToTime: (x: number) => {
        const r = chartRef.current?.timeScale().coordinateToTime(x)
        return typeof r === 'number' ? r : null
      },
      candleAt: (tSec: number) => candlesByTimeRef.current.get(tSec) ?? null,
      candles: () => candlesRef.current,
      drawings: () => drawingsRef.current,
      visibleRange: () => {
        const r = chartRef.current?.timeScale().getVisibleRange()
        return r ? { from: r.from as number, to: r.to as number } : null
      },
      visibleLogicalRange: () => chartRef.current?.timeScale().getVisibleLogicalRange() ?? null,
      markers: () => lastMarkersRef.current,
      focusInfo: () =>
        focusInfoRef.current
          ? {
              barTimeSec: focusInfoRef.current.barTimeSec,
              signalTimeMs: focusInfoRef.current.signal.signalTime,
              side: focusInfoRef.current.signal.side ?? null,
              price: focusInfoRef.current.signal.price ?? null,
            }
          : null,
    }
    return () => {
      delete w.__tbChart
    }
  }, [])

  // Escape: cancel drag / cancel draft / deselect · Delete: remove selected
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (e.key === 'Escape') {
        if (dragRef.current) {
          endDrag(true)
          return
        }
        if (tool !== 'none') {
          draftRef.current = null
          setTool('none')
          redrawOverlay()
          return
        }
        if (selectedIdRef.current != null) {
          selectedIdRef.current = null
          setSelectedId(null)
        }
        return
      }
      if (typing) return
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIdRef.current != null) {
        e.preventDefault()
        deleteSelected()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, redrawOverlay, endDrag, deleteSelected])

  /* ---------------------------------------------------------------- */
  /* Toolbar callbacks                                                 */
  /* ---------------------------------------------------------------- */

  const handleSymbolChange = useCallback((s: string) => {
    const changed = s !== symbolRef.current
    symbolRef.current = s
    setSymbol(s)
    // §7 — notify the page ONLY on a real manual change (not re-clicks of
    // the active chip) so it can drop the focus + strip the URL params.
    // m4 — a manual symbol change also drops a PANEL-driven focus (the
    // panel's signals belong to the previous symbol).
    if (changed) {
      setLocalFocus(null)
      onSymbolChangeRef.current?.(s)
    }
  }, [])

  /**
   * m4 — a MANUAL interval change drops a panel-driven local focus (same
   * §7 rule as the page-level focus). `keepLocalFocus` is passed ONLY by
   * focusSignal: its interval switch is PART of establishing a new local
   * focus, so the drop must be skipped there. An explicit flag instead of
   * relying on setLocalFocus(null)-then-setLocalFocus(payload) call order
   * inside one batched event handler — order-independent, provably correct.
   */
  const handleIntervalChange = useCallback((i: string, opts?: { keepLocalFocus?: boolean }) => {
    const changed = i !== intervalRef.current
    intervalRef.current = i
    setInterval(i)
    if (changed) {
      if (!opts?.keepLocalFocus) setLocalFocus(null)
      onIntervalChangeRef.current?.(i) // §7 — drops the page focus
    }
  }, [])

  /** §7.2 — «بازگشت به اکنون»: clear all focus visuals, drop the page-level
   *  focus (state + URL) and reload the LATEST candles with the default
   *  last-130 centering (the focus may have panned the chart into history). */
  const handleBackToNow = useCallback(() => {
    focusActiveRef.current = false
    focusBarSecRef.current = null
    setFocusInfo(null)
    setLocalFocus(null) // m4 — panel-driven focus drops too (prop drop via onFocusDrop below)
    refreshMarkers()
    refreshPriceLines()
    onFocusDropRef.current?.()
    setReloadKey((k) => k + 1)
  }, [refreshMarkers, refreshPriceLines])

  /**
   * m4 (item 4) — click a row in the «سیگنال‌های اخیر» panel → focus the
   * chart on that signal's candle through the SAME §7 centering pipeline
   * (the data-load effect resolves focusRef → applyKlines centers + marker
   * + Entry/TP/SL price lines + focus badge). The signal candle is aligned
   * to the ANALYSIS interval — when the chart shows a different interval,
   * switch first: the interval state change re-runs the data-load effect and
   * the focus-mirror effect (declared BEFORE it) has already written the
   * payload into focusRef in the same commit. Same-interval clicks bump
   * reloadKey instead (the component stays mounted — no remount, unlike the
   * shell-driven navigation).
   */
  const focusSignal = useCallback(
    (s: Signal) => {
      const signalTime = Number(s.candleOpenTime)
      if (!Number.isFinite(signalTime) || signalTime <= 0) return // no candle time → no focus
      const targetInterval =
        signalState?.analysisInterval && (INTERVALS as readonly string[]).includes(signalState.analysisInterval)
          ? signalState.analysisInterval
          : interval
      const intervalChanged = targetInterval !== interval
      if (intervalChanged) {
        handleIntervalChange(targetInterval, { keepLocalFocus: true })
        show('بازه چارت', `برای نمایش دقیق سیگنال، بازه چارت به ${targetInterval} تغییر کرد`, 'info')
      }
      setLocalFocus({
        signalTime,
        ...(s.side === 'Long' || s.side === 'Short' ? { side: s.side } : {}),
        ...(Number.isFinite(s.price) ? { price: s.price } : {}),
        ...(Number.isFinite(s.tp) ? { tp: s.tp } : {}),
        ...(Number.isFinite(s.sl) ? { sl: s.sl } : {}),
        signalId: s.id,
      })
      if (!intervalChanged) setReloadKey((k) => k + 1)
    },
    [signalState, interval, handleIntervalChange, show],
  )

  const handleToolChange = useCallback((t: DrawingToolId) => {
    draftRef.current = null
    if (selectedIdRef.current != null) {
      selectedIdRef.current = null
      setSelectedId(null)
    }
    setTool(t)
  }, [])

  const handleRefresh = useCallback(() => setReloadKey((k) => k + 1), [])

  /* ---------------------------------------------------------------- */
  /* User-defined custom symbols (persisted in localStorage)          */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    try {
      const raw = localStorage.getItem(CUSTOM_SYMBOLS_KEY)
      if (!raw) return
      const arr: unknown = JSON.parse(raw)
      if (!Array.isArray(arr)) return
      setCustomSymbols(
        arr
          .filter(
            (s): s is string =>
              typeof s === 'string' && CUSTOM_SYMBOL_RE.test(s) && !SYMBOLS.includes(s),
          )
          .slice(0, 16),
      )
    } catch {
      /* corrupted → ignore */
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_SYMBOLS_KEY, JSON.stringify(customSymbols))
    } catch {
      /* storage unavailable — session-only symbols */
    }
  }, [customSymbols])

  const handleAddSymbol = useCallback(
    (s: string) => {
      setCustomSymbols((prev) => (prev.includes(s) ? prev : [...prev, s].slice(0, 16)))
      handleSymbolChange(s) // load & switch immediately
    },
    [handleSymbolChange],
  )

  const handleRemoveSymbol = useCallback((s: string) => {
    setCustomSymbols((prev) => prev.filter((x) => x !== s))
  }, [])

  const deleteLastDrawing = useCallback(() => {
    draftRef.current = null
    setDrawings((prev) => prev.slice(0, -1))
  }, [])

  const clearDrawings = useCallback(() => {
    draftRef.current = null
    setDrawings([])
  }, [])

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const rsiVal = hoverCandle ? rsiByTimeRef.current.get(Math.floor(hoverCandle.openTime / 1000)) : undefined
  const up = hoverCandle ? hoverCandle.close >= hoverCandle.open : true
  const rsiColor =
    rsiVal == null
      ? 'var(--text-muted)'
      : rsiVal >= 70
        ? 'var(--danger)'
        : rsiVal <= 30
          ? 'var(--success)'
          : 'var(--text-primary)'

  const selectedDrawing = selectedId != null ? drawings.find((d) => d.id === selectedId) ?? null : null

  // §7 — focus legend copy (why is the chart here?)
  const focusLong = focusInfo?.signal.side !== 'Short'
  const focusHue = focusLong ? 'var(--success)' : 'var(--danger)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      {/* m4 (item 4) — signals-panel row states. globals.css is owned by other
          workstreams, so these rules ship scoped to a unique class via a
          React-hoisted <style> (deduped by href): hover background var(--bg-hover),
          disabled dimming while loading, and the dashed warning highlight for
          the pending-signal row. Backgrounds live HERE (not inline) so the
          :hover rule is not shadowed by inline styles. */}
      <style href="tb-sig-row" precedence="medium">
        {`.tb-sig-row{background:transparent;border:1px solid transparent;cursor:pointer;transition:background .12s ease}
.tb-sig-row:hover:not(:disabled){background:var(--bg-hover)}
.tb-sig-row:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.tb-sig-row:disabled{opacity:.55;cursor:default}
.tb-sig-row[data-pending='true']{border-style:dashed;border-color:var(--warning);background:color-mix(in srgb,var(--warning-soft) 45%,transparent)}
.tb-sig-row[data-pending='true']:hover:not(:disabled){background:color-mix(in srgb,var(--warning-soft) 75%,transparent)}`}
      </style>
      <ChartToolbar
        symbol={symbol}
        onSymbolChange={handleSymbolChange}
        interval={interval}
        onIntervalChange={handleIntervalChange}
        tool={tool}
        onToolChange={handleToolChange}
        loading={loading}
        onRefresh={handleRefresh}
        price={livePrice ?? lastClose}
        priceUp={priceUp}
        showSignals={showSignals}
        onToggleSignals={() => setShowSignals((v) => !v)}
        hasDrawings={drawings.length > 0}
        onDeleteDrawing={deleteLastDrawing}
        onClearDrawings={clearDrawings}
        customSymbols={customSymbols}
        onAddSymbol={handleAddSymbol}
        onRemoveSymbol={handleRemoveSymbol}
      />

      <div
        ref={wrapRef}
        className="chart-wrap"
        style={{ height: '65vh', minHeight: 420, flexShrink: 0 }}
        onPointerDownCapture={onWrapPointerDown}
        onMouseMove={onWrapMouseMove}
      >
        {/* lightweight-charts mounts here */}
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {/* drawing overlay — captures the mouse only while a tool is active */}
        {/* NOTE: canvas is a replaced element: `inset: 0` alone would leave it at its
            intrinsic 300×150 — explicit width/height are required to fill chart-wrap. */}
        <canvas
          ref={overlayRef}
          className="chart-canvas-overlay"
          style={{
            zIndex: 2,
            width: '100%',
            height: '100%',
            pointerEvents: tool === 'none' ? 'none' : 'auto',
            cursor: tool === 'none' ? 'default' : 'crosshair',
          }}
          onClick={onOverlayClick}
          onMouseMove={onOverlayMove}
        />

        {/* crosshair readout — O/H/L/C + volume + RSI */}
        <div
          style={{
            position: 'absolute',
            top: 10,
            left: 12,
            zIndex: 3,
            pointerEvents: 'none',
            direction: 'ltr',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
            padding: '5px 12px',
            borderRadius: 9,
            background: 'color-mix(in srgb, var(--bg-input) 78%, transparent)',
            border: '1px solid var(--border-soft)',
            backdropFilter: 'blur(6px)',
            fontSize: 11.5,
            fontFamily: "ui-monospace, 'JetBrains Mono', 'Fira Code', Menlo, Consolas, monospace",
            color: 'var(--text-secondary)',
            maxWidth: 'calc(100% - 96px)',
          }}
        >
          <b style={{ color: 'var(--text-primary)', letterSpacing: 0.4 }}>{symbol}</b>
          <span className="num">{interval}</span>
          {hoverCandle ? (
            <>
              <span>
                O&nbsp;<b className="num">{fmtNum(hoverCandle.open)}</b>
              </span>
              <span>
                H&nbsp;<b className="num">{fmtNum(hoverCandle.high)}</b>
              </span>
              <span>
                L&nbsp;<b className="num">{fmtNum(hoverCandle.low)}</b>
              </span>
              <span>
                C&nbsp;
                <b className="num" style={{ color: up ? 'var(--success)' : 'var(--danger)' }}>
                  {fmtNum(hoverCandle.close)}
                </b>
              </span>
              <span>
                V&nbsp;<b className="num">{fmtNum(hoverCandle.volume, 0)}</b>
              </span>
              <span>
                RSI&nbsp;
                <b className="num" style={{ color: rsiColor }}>
                  {rsiVal != null ? fmtNum(rsiVal, 1) : '—'}
                </b>
              </span>
            </>
          ) : null}
        </div>

        {/* signal legend panel — auto-sizes to its content (never clips).
            m4 (item 4): every row is a BUTTON — clicking it focuses the chart
            on that signal's candle (§7 pipeline). data-chart-ui keeps the
            drawing hit-test away from the list. */}
        {showSignals && signalState && signalState.signals.length > 0 ? (
          <div
            data-chart-ui
            style={{
              position: 'absolute',
              bottom: 46,
              left: 12,
              zIndex: 3,
              direction: 'rtl',
              width: 'max-content',
              minWidth: 210,
              maxWidth: 'min(360px, calc(100% - 24px))',
              padding: '8px 10px',
              borderRadius: 10,
              background: 'color-mix(in srgb, var(--bg-input) 84%, transparent)',
              border: '1px solid var(--border-soft)',
              backdropFilter: 'blur(6px)',
              fontSize: 11,
              color: 'var(--text-secondary)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 6,
                marginBottom: 6,
                color: 'var(--text-primary)',
                fontWeight: 700,
                fontSize: 11.5,
              }}
            >
              <i className="ph ph-chart-line-up" style={{ color: 'var(--accent)', fontSize: 14 }} aria-hidden />
              سیگنال‌های اخیر
              <span className="badge badge-accent" style={{ fontSize: 10, padding: '2px 8px' }}>
                <span className="num">{signalState.signals.length}</span>
              </span>
              {signalState.analysisInterval && signalState.analysisInterval !== interval ? (
                <span className="badge badge-warning" style={{ fontSize: 9.5, padding: '2px 7px' }}>
                  بازه تحلیل <span className="num">{signalState.analysisInterval}</span>
                </span>
              ) : null}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 168, overflowY: 'auto' }}>
              {signalState.signals
                .slice() // m4 — ALL signals (was slice(-6)), newest first
                .reverse()
                .map((s) => {
                  const isLong = s.side === 'Long'
                  const isPending = signalState.pending?.id === s.id
                  const st = s.status ? SIGNAL_STATUS_META[s.status] : null
                  // m4 — compact Jalali chip: full «YYYY/MM/DD, HH:mm:ss»
                  // lives in the row title; the chip shows date · HH:mm.
                  const dtFull = fmtDateTime(s.signalConfirmedAt)
                  const [dtDate, dtTime] = dtFull.split(', ')
                  const dtChip = dtDate && dtTime ? `${dtDate} · ${dtTime.slice(0, 5)}` : dtFull
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className="tb-sig-row"
                      data-pending={isPending ? 'true' : undefined}
                      disabled={loading}
                      onClick={() => focusSignal(s)}
                      title={`نمایش سیگنال ${isLong ? 'لانگ' : 'شورت'} ${symbol} در چارت — ${dtFull}`}
                      aria-label={`نمایش سیگنال ${isLong ? 'لانگ' : 'شورت'} ${symbol} در ساعت ${dtTime ?? dtFull}`}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: 6,
                        rowGap: 2,
                        justifyContent: 'space-between',
                        width: '100%',
                        textAlign: 'start',
                        padding: '4px 6px',
                        borderRadius: 6,
                        fontFamily: 'inherit',
                        fontSize: 'inherit',
                        color: 'inherit',
                        lineHeight: 1.6,
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <i
                          className={`ph ${isLong ? 'ph-trend-up' : 'ph-trend-down'}`}
                          style={{ color: isLong ? 'var(--success)' : 'var(--danger)', fontSize: 13 }}
                          aria-hidden
                        />
                        <b style={{ color: isLong ? 'var(--success)' : 'var(--danger)' }}>{isLong ? 'Long' : 'Short'}</b>
                        {isPending ? (
                          <i className="ph ph-clock" style={{ color: 'var(--warning)', fontSize: 12 }} aria-hidden />
                        ) : null}
                      </span>
                      <span className="num" style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 10.5 }}>
                        {fmtPrice(s.price)}
                      </span>
                      <span className="num" style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        TP {fmtNum(s.tp, 1)} / SL {fmtNum(s.sl, 1)}
                      </span>
                      <span
                        className="num"
                        title={dtFull}
                        style={{ fontSize: 9.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}
                      >
                        {dtChip}
                      </span>
                      {st ? (
                        <span className={`badge ${st.cls}`} style={{ fontSize: 9.5, padding: '2px 7px', flexShrink: 0 }}>
                          {st.label}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
            </div>
            <div style={{ fontSize: 9.5, color: 'var(--text-muted)', marginTop: 6 }}>
              برای پرش به سیگنال، روی ردیف کلیک کنید
            </div>
          </div>
        ) : null}

        {/* §7 — focus badge: why the chart is centered here + quick way back */}
        {focusInfo ? (
          <div
            data-chart-ui
            style={{
              position: 'absolute',
              bottom: 46,
              right: 12,
              zIndex: 4,
              direction: 'rtl',
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 7,
              rowGap: 4,
              padding: '6px 10px',
              borderRadius: 10,
              background: 'color-mix(in srgb, var(--bg-input) 92%, transparent)',
              border: '1px solid var(--border-soft)',
              backdropFilter: 'blur(6px)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              maxWidth: 'calc(100% - 24px)',
            }}
          >
            <i className={`ph-fill ${focusLong ? 'ph-trend-up' : 'ph-trend-down'}`} style={{ color: focusHue, fontSize: 14 }} aria-hidden />
            <span className={`badge ${focusLong ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: 10, padding: '2px 8px' }}>
              سیگنال {focusLong ? 'لانگ' : 'شورت'}
            </span>
            {focusInfo.signal.price != null ? (
              <span className="num" style={{ color: 'var(--text-primary)', fontWeight: 700, fontSize: 10.5 }}>
                {fmtPrice(focusInfo.signal.price)}
              </span>
            ) : null}
            {focusInfo.signal.tp != null && focusInfo.signal.sl != null ? (
              <span className="num" style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                TP {fmtNum(focusInfo.signal.tp, 1)} / SL {fmtNum(focusInfo.signal.sl, 1)}
              </span>
            ) : null}
            <span className="num" style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>
              {interval}
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ padding: '3px 8px', fontSize: 10.5, whiteSpace: 'nowrap' }}
              onClick={handleBackToNow}
              data-tooltip="برگشت به جدیدترین کندل‌ها و پاک‌کردن فوکوس"
              aria-label="بازگشت به اکنون — جدیدترین کندل‌ها"
            >
              <i className="ph ph-arrow-elbow-left" aria-hidden />
              بازگشت به اکنون
            </button>
          </div>
        ) : null}

        {/* drawing editor — visible while a drawing is selected */}
        {selectedDrawing && tool === 'none' ? (
          <div
            data-chart-ui
            style={{
              position: 'absolute',
              top: 10,
              right: 64,
              zIndex: 6,
              direction: 'rtl',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '7px 10px',
              borderRadius: 10,
              background: 'color-mix(in srgb, var(--bg-input) 92%, transparent)',
              border: '1px solid var(--border-soft)',
              backdropFilter: 'blur(6px)',
              boxShadow: '0 4px 14px rgba(15, 23, 42, 0.08)',
            }}
          >
            <i className="ph ph-paint-brush" style={{ color: 'var(--accent)', fontSize: 15 }} aria-hidden />
            <span style={{ fontSize: 11, color: 'var(--text-primary)', fontWeight: 700, whiteSpace: 'nowrap' }}>
              ویرایش رسم
            </span>
            <span style={{ display: 'inline-flex', gap: 5 }}>
              {DRAW_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => applySelectedColor(c)}
                  aria-label={`رنگ ${c}`}
                  data-tooltip={c}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    background: c,
                    cursor: 'pointer',
                    border:
                      selectedDrawing.color === c || (selectedDrawing.color == null && c === DRAW_COLORS[0])
                        ? '2px solid var(--text-primary)'
                        : '1px solid var(--border-color)',
                    padding: 0,
                  }}
                />
              ))}
            </span>
            <button
              type="button"
              className="tool-btn"
              style={{ width: 26, height: 26, fontSize: 13, color: 'var(--danger)' }}
              data-tooltip="حذف رسم انتخابی (Delete)"
              aria-label="حذف رسم انتخابی"
              onClick={deleteSelected}
            >
              <i className="ph ph-trash" aria-hidden />
            </button>
            <button
              type="button"
              className="tool-btn"
              style={{ width: 26, height: 26, fontSize: 13 }}
              data-tooltip="بستن ویرایشگر (Esc)"
              aria-label="بستن ویرایشگر"
              onClick={() => {
                selectedIdRef.current = null
                setSelectedId(null)
              }}
            >
              <i className="ph ph-x" aria-hidden />
            </button>
            <span style={{ fontSize: 9.5, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              گره‌ها را بکشید · Esc = لغو
            </span>
          </div>
        ) : null}
        {loading ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 5,
              display: 'grid',
              placeItems: 'center',
              background: 'color-mix(in srgb, var(--bg-input) 68%, transparent)',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                color: 'var(--text-muted)',
                fontSize: 12.5,
              }}
            >
              <i className="ph ph-circle-notch spin" style={{ fontSize: 30, color: 'var(--accent)' }} aria-hidden />
              در حال دریافت داده‌های بازار…
            </div>
          </div>
        ) : null}

        {/* error card + retry */}
        {error ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 6,
              display: 'grid',
              placeItems: 'center',
              background: 'color-mix(in srgb, var(--bg-input) 84%, transparent)',
            }}
          >
            <div
              className="card"
              style={{
                padding: 18,
                maxWidth: 380,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                textAlign: 'center',
              }}
            >
              <i className="ph ph-warning" style={{ fontSize: 30, color: 'var(--danger)' }} aria-hidden />
              <b style={{ fontSize: 13.5, color: 'var(--text-primary)' }}>خطا در دریافت داده‌های چارت</b>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>{error}</span>
              <button type="button" className="btn btn-outline btn-sm" onClick={handleRefresh}>
                <i className="ph ph-arrows-clockwise" aria-hidden />
                تلاش مجدد
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="form-hint" style={{ marginTop: -2 }}>
        <i className="ph ph-info" style={{ color: 'var(--accent)', verticalAlign: '-2px' }} aria-hidden />{' '}
        رسم‌ها با جابه‌جایی و بزرگ‌نمایی چارت همراه داده‌ها حرکت می‌کنند. برای ویرایش، در حالت عادی روی رسم کلیک کنید:
        گره‌هایش را بکشید، رنگش را عوض کنید یا با Delete حذفش کنید (Esc = لغو). با علامت + هر نماد دلخواه
        توبیت را به فهرست اضافه کنید. نزدیک نوک کندل‌ها، قیمت دقیقاً به سقف/کف کندل قفل می‌شود (مگنت).
      </p>
    </div>
  )
}

export default ChartView
