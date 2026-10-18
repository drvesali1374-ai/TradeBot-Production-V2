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
import type { MouseEvent as ReactMouseEvent } from 'react'
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
import { fmtNum, fmtPrice } from '@/modules/common/format'
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
import { renderDrawing, type OverlayRenderInput } from './drawingRender'
import {
  INTERVAL_MS,
  type AnalysisResponse,
  type Candle,
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
  onSymbolChange?: (symbol: string) => void
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

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function ChartView({ initialSymbol, onSymbolChange }: ChartViewProps) {
  /* ——— state ——— */
  const [symbol, setSymbol] = useState(initialSymbol || 'BTC')
  const [interval, setInterval] = useState('1h')
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
  const nextIdRef = useRef(1)
  const onSymbolChangeRef = useRef(onSymbolChange)
  const prevTickRef = useRef<number | null>(null)

  useEffect(() => {
    onSymbolChangeRef.current = onSymbolChange
  }, [onSymbolChange])

  /* ---------------------------------------------------------------- */
  /* Overlay rendering (logical → pixel on every chart redraw)        */
  /* ---------------------------------------------------------------- */

  const redrawOverlay = useCallback(() => {
    const canvas = overlayRef.current
    const chart = chartRef.current
    const series = candleRef.current
    if (!canvas || !chart || !series) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.clientWidth
    const h = canvas.clientHeight
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

    const ts = chart.timeScale()
    const input: OverlayRenderInput = {
      w,
      h,
      xOfTime: (t) => ts.timeToCoordinate(t as UTCTimestamp),
      yOfPrice: (p) => series.priceToCoordinate(p),
      palette: readPalette(),
      intervalMs: intervalMsRef.current,
    }
    for (const d of drawingsRef.current) renderDrawing(ctx, input, d)
    const draft = draftRef.current
    if (draft) renderDrawing(ctx, { ...input, isPreview: true }, draft)
  }, [])

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
      list.sort((a, b) => (a.time as number) - (b.time as number))
    }
    api.setMarkers(list)
  }, [])

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
    const pending = analysisRef.current?.pendingSignal
    if (!pending || !signalsVisibleRef.current) return
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
      mk(pending.price, ENTRY_COLOR, LineStyle.Solid, 'Entry'),
      mk(pending.tp, UP_COLOR, LineStyle.Dashed, 'TP'),
      mk(pending.sl, DOWN_COLOR, LineStyle.Dashed, 'SL'),
    ]
  }, [])

  /* ---------------------------------------------------------------- */
  /* Data application                                                  */
  /* ---------------------------------------------------------------- */

  const applyKlines = useCallback(
    (candles: Candle[]) => {
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
        // focus the last ~130 candles
        const n = candles.length
        chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 130), to: n + 6 })
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
        const candles = (kl.candles ?? []).slice().sort((a, b) => a.openTime - b.openTime)
        if (candles.length === 0) throw new Error('کندلی برای این نماد یافت نشد')
        applyKlines(candles)
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
  }, [symbol, interval, reloadKey, applyKlines, applyAnalysis])

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
      if (tool === 'none') return
      const x = e.nativeEvent.offsetX
      const y = e.nativeEvent.offsetY
      const timeAt = (): number | null => {
        const t = chart.timeScale().coordinateToTime(x)
        return typeof t === 'number' ? t : null
      }
      const priceAt = (): number | null => series.coordinateToPrice(y)

      if (tool === 'hline') {
        const price = priceAt()
        if (price == null) return
        pushDrawing({ type: 'hline', price1: price, time1: 0, price2: price, time2: 0 })
        setTool('none')
      } else if (tool === 'vline') {
        const t = timeAt()
        if (t == null) return
        pushDrawing({ type: 'vline', time1: t, price1: 0, time2: t, price2: 0 })
        setTool('none')
      } else if (tool === 'trend' || tool === 'rect' || tool === 'measure') {
        const draft = draftRef.current
        if (!draft) {
          const price = priceAt()
          const t = timeAt()
          if (price == null || t == null) return
          draftRef.current = { type: tool, time1: t, price1: price, time2: t, price2: price }
        } else {
          const price = priceAt()
          const t = timeAt()
          if (price == null || t == null) return
          draftRef.current = null
          pushDrawing({ type: draft.type, time1: draft.time1, price1: draft.price1, time2: t, price2: price })
          setTool('none')
        }
      }
      redrawOverlay()
    },
    [tool, pushDrawing, redrawOverlay],
  )

  const onOverlayMove = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      const draft = draftRef.current
      if (!draft) return
      const chart = chartRef.current
      const series = candleRef.current
      if (!chart || !series) return
      const t = chart.timeScale().coordinateToTime(e.nativeEvent.offsetX)
      const price = series.coordinateToPrice(e.nativeEvent.offsetY)
      if (price != null) draft.price2 = price
      if (typeof t === 'number') draft.time2 = t
      redrawOverlay()
    },
    [redrawOverlay],
  )

  // Escape cancels the in-progress drawing
  useEffect(() => {
    if (tool === 'none') return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        draftRef.current = null
        setTool('none')
        redrawOverlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, redrawOverlay])

  /* ---------------------------------------------------------------- */
  /* Toolbar callbacks                                                 */
  /* ---------------------------------------------------------------- */

  const handleSymbolChange = useCallback((s: string) => {
    symbolRef.current = s
    setSymbol(s)
    onSymbolChangeRef.current?.(s)
  }, [])

  const handleIntervalChange = useCallback((i: string) => {
    setInterval(i)
  }, [])

  const handleRefresh = useCallback(() => setReloadKey((k) => k + 1), [])

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <ChartToolbar
        symbol={symbol}
        onSymbolChange={handleSymbolChange}
        interval={interval}
        onIntervalChange={handleIntervalChange}
        tool={tool}
        onToolChange={setTool}
        loading={loading}
        onRefresh={handleRefresh}
        price={livePrice ?? lastClose}
        priceUp={priceUp}
        showSignals={showSignals}
        onToggleSignals={() => setShowSignals((v) => !v)}
        hasDrawings={drawings.length > 0}
        onDeleteDrawing={deleteLastDrawing}
        onClearDrawings={clearDrawings}
      />

      <div className="chart-wrap" style={{ height: '65vh', minHeight: 420, flexShrink: 0 }}>
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

        {/* signal legend panel */}
        {showSignals && signalState && signalState.signals.length > 0 ? (
          <div
            style={{
              position: 'absolute',
              bottom: 46,
              left: 12,
              zIndex: 3,
              pointerEvents: 'none',
              direction: 'rtl',
              width: 250,
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxHeight: 158, overflowY: 'auto' }}>
              {signalState.signals
                .slice(-6)
                .reverse()
                .map((s) => {
                  const isLong = s.side === 'Long'
                  const isPending = signalState.pending?.id === s.id
                  const st = s.status ? SIGNAL_STATUS_META[s.status] : null
                  return (
                    <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
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
                      {st ? (
                        <span className={`badge ${st.cls}`} style={{ fontSize: 9.5, padding: '2px 7px', flexShrink: 0 }}>
                          {st.label}
                        </span>
                      ) : null}
                    </div>
                  )
                })}
            </div>
          </div>
        ) : null}

        {/* loading veil */}
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
        برای رسم روی چارت یکی از ابزارها را انتخاب کنید (Esc = لغو رسم). رسم‌ها با جابه‌جایی و بزرگ‌نمایی چارت همراه
        داده‌ها حرکت می‌کنند.
      </p>
    </div>
  )
}

export default ChartView
