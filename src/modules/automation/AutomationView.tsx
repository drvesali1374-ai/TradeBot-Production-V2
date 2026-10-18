'use client'

/**
 * Automation view — the main control & observation panel (instruction §10).
 * Sections (each independently refreshable, read endpoints never trade):
 *  1. Cycle status (last result + steps)   4. Signals & market data
 *  2. Symbols & scheduling                 5. Balance & risk
 *  3. Open positions                       6. Logs & diagnostics
 * Manual execution ONLY via «یک چرخه» — cron drives the schedule.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import { fmtNum, fmtPrice, fmtUsd, fmtPct, fmtTime, fmtDateTime, fmtAgo, fmtQty, pnlColor, shortSymbol } from '@/modules/common/format'
import type { CycleResult, SymbolEntry, OpenPosition, LogRecord, BalanceInfo, Signal } from '@/core/types'

/* ------------------------------------------------------------------ */
/* shared bits                                                         */
/* ------------------------------------------------------------------ */

function PanelCard({
  title,
  icon,
  actions,
  children,
  className,
}: {
  title: string
  icon: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`card panel-card${className ? ` ${className}` : ''}`}>
      <div className="panel-title">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className={icon} aria-hidden /> {title}
        </span>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>{actions}</span>
      </div>
      {children}
    </section>
  )
}

function RefreshBtn({ onClick, busy, label }: { onClick: () => void; busy?: boolean; label: string }) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={onClick}
      disabled={busy}
      data-tooltip={label}
      aria-label={label}
    >
      <i className={`ph ${busy ? 'ph-circle-notch spin' : 'ph-arrows-clockwise'}`} aria-hidden />
    </button>
  )
}

const ACTION_LABELS: Record<string, { text: string; cls: string }> = {
  NO_READY_SYMBOL: { text: 'نماد آماده نبود', cls: 'badge-info' },
  MARKET_DATA_FAILED: { text: 'خطای داده بازار', cls: 'badge-danger' },
  NO_SIGNAL: { text: 'بدون سیگنال', cls: 'badge-info' },
  SIGNAL_EXPIRED: { text: 'سیگنال منقضی', cls: 'badge-warning' },
  SIGNAL_STALE: { text: 'سیگنال قدیمی', cls: 'badge-warning' },
  ALREADY_PROCESSED: { text: 'قبلاً پردازش شده', cls: 'badge-info' },
  RISK_REJECTED: { text: 'رد توسط ریسک', cls: 'badge-warning' },
  POSITION_OPENED: { text: 'پوزیشن باز شد', cls: 'badge-success' },
  POSITION_OPENED_TPSL_FAILED: { text: 'باز شد — TP/SL خطا', cls: 'badge-warning' },
  OPPOSITE_CLOSED_THEN_OPENED: { text: 'مخالف بسته + باز شد', cls: 'badge-success' },
  ERROR: { text: 'خطا', cls: 'badge-danger' },
}

const STEP_ICON: Record<string, string> = {
  ok: 'ph-fill ph-check-circle',
  info: 'ph-fill ph-info',
  skipped: 'ph-fill ph-minus-circle',
  warning: 'ph-fill ph-warning',
  failed: 'ph-fill ph-x-circle',
}

const SIGNAL_STATUS: Record<string, { text: string; cls: string }> = {
  PENDING: { text: 'در انتظار', cls: 'badge-accent' },
  OPENED: { text: 'باز شده', cls: 'badge-success' },
  EXPIRED: { text: 'منقضی شده', cls: 'badge-warning' },
  NOT_OPENED: { text: 'باز نشده', cls: 'badge-info' },
}

/* ------------------------------------------------------------------ */
/* main view                                                           */
/* ------------------------------------------------------------------ */

interface AutomationViewProps {
  refreshKey: number
  onRefreshAll: () => void
  onGoChart: (symbol: string) => void
  onRunCycle: () => void
  running: boolean
}

export function AutomationView({ refreshKey, onRefreshAll, onGoChart, onRunCycle, running }: AutomationViewProps) {
  const { show } = useToast()

  const [status, setStatus] = useState<{ lastResult: CycleResult | null; symbols: SymbolEntry[]; lock: unknown; tradeWaitTime: number; storage: { reads: number; writes: number; lifetimeReads: number; lifetimeWrites: number } } | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)

  const [analysis, setAnalysis] = useState<{ symbol: string; interval: string; lastPrice: number | null; pendingSignal: (Signal & { status?: string }) | null; signals: (Signal & { status?: string })[]; meta: { closedCount: number; candleCount: number } } | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [analysisSymbol, setAnalysisSymbol] = useState('BTC')

  const [balance, setBalance] = useState<BalanceInfo | null>(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [balanceMode, setBalanceMode] = useState<'live' | 'demo'>('demo')

  const [positions, setPositions] = useState<OpenPosition[]>([])
  const [positionsBusy, setPositionsBusy] = useState(false)

  const [logs, setLogs] = useState<LogRecord[]>([])
  const [logsBusy, setLogsBusy] = useState(false)

  const [newSymbol, setNewSymbol] = useState('')
  const [symbolBusy, setSymbolBusy] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)

  /* ---------------- fetchers (dependency-aware) ---------------- */

  const loadStatus = useCallback(async () => {
    setStatusBusy(true)
    try {
      const r = await apiGet<typeof status>('/api/automation/status')
      setStatus(r)
    } catch (e) {
      if ((e as { status?: number }).status !== 401) show('وضعیت', 'دریافت وضعیت ناموفق بود', 'warning')
    } finally {
      setStatusBusy(false)
    }
  }, [show])

  const loadAnalysis = useCallback(async (symbol: string) => {
    setAnalysisBusy(true)
    try {
      const r = await apiGet<NonNullable<typeof analysis>>(`/api/market/analysis?symbol=${encodeURIComponent(symbol)}`)
      setAnalysis(r)
    } catch (e) {
      show('تحلیل بازار', e instanceof Error ? e.message : 'خطا', 'warning')
    } finally {
      setAnalysisBusy(false)
    }
  }, [show])

  const loadBalance = useCallback(async () => {
    setBalanceBusy(true)
    try {
      const r = await apiGet<{ balance: BalanceInfo; mode: 'live' | 'demo' }>('/api/account/balance')
      setBalance(r.balance)
      setBalanceMode(r.mode)
    } catch (e) {
      show('موجودی', e instanceof Error ? e.message : 'خطا', 'warning')
    } finally {
      setBalanceBusy(false)
    }
  }, [show])

  const loadPositions = useCallback(async () => {
    setPositionsBusy(true)
    try {
      const r = await apiGet<{ positions: OpenPosition[] }>('/api/positions/open')
      setPositions(r.positions)
    } catch (e) {
      show('پوزیشن‌ها', e instanceof Error ? e.message : 'خطا', 'warning')
    } finally {
      setPositionsBusy(false)
    }
  }, [show])

  const loadLogs = useCallback(async () => {
    setLogsBusy(true)
    try {
      const r = await apiGet<{ logs: LogRecord[] }>('/api/diagnostics/logs?limit=40')
      setLogs(r.logs)
    } catch {
      /* silent */
    } finally {
      setLogsBusy(false)
    }
  }, [])

  // initial + on global refresh
  useEffect(() => {
    loadStatus()
    loadBalance()
    loadPositions()
    loadLogs()
  }, [refreshKey, loadStatus, loadBalance, loadPositions, loadLogs])

  // analysis follows its own symbol selector
  useEffect(() => {
    loadAnalysis(analysisSymbol)
  }, [analysisSymbol, refreshKey, loadAnalysis])

  // balance refresh refreshes positions too (dependency: positions panel
  // uses margin that affects risk), positions refresh refreshes balance
  const refreshBalance = () => {
    loadBalance()
    loadPositions()
  }
  const refreshPositions = () => {
    loadPositions()
    loadBalance()
    loadStatus()
  }

  /* ---------------- actions ---------------- */

  const addSymbol = async () => {
    const name = newSymbol.trim().toUpperCase()
    if (!name) return
    setSymbolBusy(true)
    try {
      const r = await apiPost<{ symbols: SymbolEntry[] }>('/api/automation/symbols', { action: 'add', symbol: name })
      setStatus((s) => (s ? { ...s, symbols: r.symbols } : s))
      setNewSymbol('')
      show('نمادها', `${name} اضافه شد`, 'success')
    } catch (e) {
      show('نمادها', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setSymbolBusy(false)
    }
  }

  const removeSymbol = async (name: string) => {
    setSymbolBusy(true)
    try {
      const r = await apiPost<{ symbols: SymbolEntry[] }>('/api/automation/symbols', { action: 'remove', symbol: name })
      setStatus((s) => (s ? { ...s, symbols: r.symbols } : s))
      show('نمادها', `${name} حذف شد`, 'info')
    } catch (e) {
      show('نمادها', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setSymbolBusy(false)
    }
  }

  const clearErrors = async () => {
    try {
      const r = await apiPost<{ symbols: SymbolEntry[] }>('/api/automation/symbols', { action: 'clear-errors' })
      setStatus((s) => (s ? { ...s, symbols: r.symbols } : s))
      show('نمادها', 'خطاهای نمادها پاکسازی شد', 'success')
    } catch (e) {
      show('نمادها', e instanceof Error ? e.message : 'خطا', 'danger')
    }
  }

  const closePosition = async (pos: OpenPosition) => {
    const sym = shortSymbol(pos.symbol)
    const direction = pos.side === 'LONG' ? 'long' : 'short'
    setClosing(pos.symbol + pos.side)
    try {
      const r = await apiPost<{ success: boolean; closed: number; total: number }>('/api/positions/close', { symbol: sym, direction })
      show(
        'بستن پوزیشن',
        r.success ? `${sym} ${pos.side === 'LONG' ? 'لانگ' : 'شورت'} بسته شد` : 'پوزیشنی برای بستن یافت نشد',
        r.success ? 'success' : 'warning'
      )
      refreshPositions()
    } catch (e) {
      show('بستن پوزیشن', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setClosing(null)
    }
  }

  /* ---------------- derived ---------------- */

  const last = status?.lastResult ?? null
  const actionInfo = last ? ACTION_LABELS[last.action] ?? { text: last.action, cls: 'badge-info' } : null
  const pending = analysis?.pendingSignal ?? null
  const symbolPositions = positions

  const lastRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (last && lastRef.current) lastRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [last?.cycleId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ============ 1. cycle status ============ */}
      <div ref={lastRef}>
        <PanelCard
          title="وضعیت چرخه"
          icon="ph-fill ph-pulse"
          actions={
            <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} className="num">
                R:{status?.storage.lifetimeReads ?? 0} / W:{status?.storage.lifetimeWrites ?? 0}
              </span>
              <RefreshBtn onClick={loadStatus} busy={statusBusy} label="به‌روزرسانی وضعیت" />
            </>
          }
        >
          {running ? (
            <div className="empty-state pulse-soft" style={{ padding: 18 }}>
              <i className="ph-fill ph-circle-notch spin" aria-hidden />
              چرخه در حال اجراست…
            </div>
          ) : last ? (
            <>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                <span className={`badge ${actionInfo!.cls}`}>
                  <span className="badge-dot-sm" /> {actionInfo!.text}
                </span>
                <span className="badge badge-accent">
                  <i className="ph ph-clock" aria-hidden /> <span className="num">{(last.durationMs / 1000).toFixed(1)}s</span>
                </span>
                {last.symbol ? (
                  <span className="badge badge-info">
                    <i className="ph ph-coin" aria-hidden /> {last.symbol}
                  </span>
                ) : null}
                <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                  <i className="ph ph-hash" aria-hidden /> <span className="mono" style={{ fontSize: 10 }}>{last.cycleId}</span>
                </span>
                <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                  {last.source === 'cron' ? 'کرون' : 'دستی'} · {fmtDateTime(last.finishedAt)}
                </span>
                {last.demo ? (
                  <span className="demo-pill">
                    <i className="ph-fill ph-flask" aria-hidden /> شبیه‌سازی
                  </span>
                ) : null}
              </div>

              {last.error ? (
                <div className="badge badge-danger" style={{ width: '100%', justifyContent: 'flex-start', padding: '10px 14px', borderRadius: 12, marginBottom: 12 }}>
                  <i className="ph-fill ph-warning-circle" aria-hidden /> {last.error}
                </div>
              ) : null}

              {last.reason ? (
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
                  علت: <b>{last.reason}</b>
                </p>
              ) : null}

              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {last.steps.map((s) => (
                  <div className="step-item" data-status={s.status} key={`${last.cycleId}-${s.step}`}>
                    <span className="step-num num">{s.step}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontWeight: 600 }}>{s.name}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: 10.5 }} className="num">
                          {s.durationMs != null ? `${s.durationMs}ms` : ''} · {fmtTime(s.at)}
                        </span>
                      </div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{s.message}</div>
                    </div>
                    <i className={STEP_ICON[s.status] ?? 'ph-fill ph-info'} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
                  </div>
                ))}
              </div>

              {last.storage ? (
                <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
                  بودجه ذخیره‌سازی این چرخه: <span className="num">{last.storage.reads}</span> خواندن ·{' '}
                  <span className="num">{last.storage.writes}</span> نوشتن
                </p>
              ) : null}
            </>
          ) : (
            <div className="empty-state">
              <i className="ph ph-pulse" aria-hidden />
              هنوز چرخه‌ای اجرا نشده — با دکمه «یک چرخه» شروع کنید
            </div>
          )}

          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" onClick={onRunCycle} disabled={running}>
              <i className={`ph ${running ? 'ph-circle-notch spin' : 'ph-play'}`} aria-hidden />
              <span>اجرای یک چرخه</span>
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 10 }}>
              زمان‌بندی اصلی: کرون ابر (هر ۵ دقیقه) — این دکمه همان موتور را اجرا می‌کند
            </span>
          </div>
        </PanelCard>
      </div>

      <div className="content-grid">
        {/* left column: market + signals */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          {/* ============ 4. market data + signals ============ */}
          <PanelCard
            title="داده بازار و سیگنال‌ها"
            icon="ph-fill ph-chart-candlestick"
            actions={
              <>
                <select
                  className="form-input"
                  style={{ width: 110, padding: '6px 10px', fontSize: 12 }}
                  value={analysisSymbol}
                  onChange={(e) => setAnalysisSymbol(e.target.value.toUpperCase())}
                  aria-label="نماد تحلیل"
                >
                  {(status?.symbols ?? [{ name: 'BTC' }, { name: 'ETH' }, { name: 'DOT' }]).map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <RefreshBtn
                  onClick={() => loadAnalysis(analysisSymbol)}
                  busy={analysisBusy}
                  label="به‌روزرسانی داده بازار و محاسبات (وابستگی‌ها همگام می‌شوند)"
                />
              </>
            }
          >
            {analysis ? (
              <>
                <div className="kpi-grid" style={{ marginBottom: 14 }}>
                  <div className="kpi-box">
                    <div className="kpi-label">آخرین قیمت</div>
                    <div className="kpi-value">{fmtPrice(analysis.lastPrice)}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">کندل بسته‌شده</div>
                    <div className="kpi-value num">{analysis.meta.closedCount}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">تایم‌فریم</div>
                    <div className="kpi-value">{analysis.interval}</div>
                  </div>
                  <div className="kpi-box">
                    <div className="kpi-label">سیگنال‌ها</div>
                    <div className="kpi-value num">{analysis.signals.length}</div>
                  </div>
                </div>

                {pending ? (
                  <div
                    className="toggle-row"
                    style={{ cursor: 'default', marginBottom: 12, background: pending.side === 'Long' ? 'var(--success-soft)' : 'var(--danger-soft)' }}
                  >
                    <div className="toggle-row-left">
                      <i className={`ph-fill ${pending.side === 'Long' ? 'ph-trend-up' : 'ph-trend-down'}`} style={{ color: pending.side === 'Long' ? 'var(--success)' : 'var(--danger)' }} aria-hidden />
                      <div>
                        <div className="toggle-label">
                          سیگنال آماده: {pending.side === 'Long' ? 'لانگ' : 'شورت'} {pending.symbol}
                        </div>
                        <div className="toggle-desc">
                          ورود <span className="num">{fmtPrice(pending.price)}</span> · TP{' '}
                          <span className="num long">{fmtPrice(pending.tp)}</span> · SL{' '}
                          <span className="num short">{fmtPrice(pending.sl)}</span> · تأیید {fmtDateTime(pending.signalConfirmedAt)}
                        </div>
                      </div>
                    </div>
                    <span className={`badge ${SIGNAL_STATUS[pending.status ?? 'PENDING'].cls}`}>{SIGNAL_STATUS[pending.status ?? 'PENDING'].text}</span>
                  </div>
                ) : (
                  <div className="empty-state" style={{ padding: 18 }}>
                    <i className="ph ph-chart-line-down" aria-hidden />
                    سیگنال آماده‌ای وجود ندارد
                  </div>
                )}

                <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                  <table className="tb-table" style={{ minWidth: 480 }}>
                    <thead>
                      <tr>
                        <th>زمان</th>
                        <th>جهت</th>
                        <th>قیمت</th>
                        <th>TP</th>
                        <th>SL</th>
                        <th>وضعیت</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {[...analysis.signals].reverse().slice(0, 12).map((s) => (
                        <tr key={s.id}>
                          <td style={{ fontSize: 12 }}>{fmtDateTime(s.signalConfirmedAt)}</td>
                          <td>
                            <span className={s.side === 'Long' ? 'long' : 'short'} style={{ fontWeight: 700 }}>
                              {s.side === 'Long' ? 'لانگ' : 'شورت'}
                            </span>
                          </td>
                          <td className="mono">{fmtPrice(s.price)}</td>
                          <td className="mono long">{fmtPrice(s.tp)}</td>
                          <td className="mono short">{fmtPrice(s.sl)}</td>
                          <td>
                            <span className={`badge ${SIGNAL_STATUS[s.status ?? 'NOT_OPENED'].cls}`} style={{ fontSize: 10 }}>
                              {SIGNAL_STATUS[s.status ?? 'NOT_OPENED'].text}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => onGoChart(shortSymbol(s.symbol))}
                              data-tooltip="نمایش در چارت"
                            >
                              <i className="ph ph-candlestick-chart" aria-hidden />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <i className="ph ph-circle-notch spin" aria-hidden />
                در حال دریافت تحلیل…
              </div>
            )}
          </PanelCard>

          {/* ============ 6. open positions ============ */}
          <PanelCard
            title={`پوزیشن‌های باز (${positions.length})`}
            icon="ph-fill ph-arrows-down-up"
            actions={<RefreshBtn onClick={refreshPositions} busy={positionsBusy} label="به‌روزرسانی پوزیشن‌ها و موجودی" />}
          >
            {positions.length === 0 ? (
              <div className="empty-state">
                <i className="ph ph-inbox" aria-hidden />
                پوزیشن بازی وجود ندارد
              </div>
            ) : (
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                <table className="tb-table" style={{ minWidth: 560 }}>
                  <thead>
                    <tr>
                      <th>نماد</th>
                      <th>جهت</th>
                      <th>قیمت ورود</th>
                      <th>قیمت فعلی</th>
                      <th>مقدار</th>
                      <th>اهرم</th>
                      <th>مارجین</th>
                      <th>سود/زیان</th>
                      <th>TP / SL</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((p) => (
                      <tr key={p.symbol + p.side}>
                        <td>
                          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onGoChart(shortSymbol(p.symbol))} style={{ fontWeight: 700 }}>
                            {shortSymbol(p.symbol)}
                          </button>
                        </td>
                        <td>
                          <span className={p.side === 'LONG' ? 'long' : 'short'} style={{ fontWeight: 700 }}>
                            {p.side === 'LONG' ? 'لانگ' : 'شورت'}
                          </span>
                        </td>
                        <td className="mono">{fmtPrice(p.entryPrice)}</td>
                        <td className="mono">{fmtPrice(p.markPrice)}</td>
                        <td className="mono num">{fmtQty(p.qty)}</td>
                        <td className="mono num">{p.leverage}x</td>
                        <td className="mono">{fmtUsd(p.margin)}</td>
                        <td className="mono" style={{ color: pnlColor(p.unrealizedPnL) }}>
                          {fmtUsd(p.unrealizedPnL)} <small>({fmtPct(p.profitRate)})</small>
                        </td>
                        <td style={{ fontSize: 11 }}>
                          {p.takeProfit ? <span className="mono long">{fmtPrice(p.takeProfit)}</span> : '—'} /{' '}
                          {p.stopLoss ? <span className="mono short">{fmtPrice(p.stopLoss)}</span> : '—'}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => closePosition(p)}
                            disabled={closing === p.symbol + p.side}
                          >
                            <i className={`ph ${closing === p.symbol + p.side ? 'ph-circle-notch spin' : 'ph-x'}`} aria-hidden />
                            <span>بستن</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </PanelCard>
        </div>

        {/* right column */}
        <div className="side-panel">
          {/* ============ 2. symbols ============ */}
          <PanelCard
            title="نمادها و زمان‌بندی"
            icon="ph-fill ph-coins"
            actions={
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearErrors} data-tooltip="پاکسازی خطاها">
                  <i className="ph ph-broom" aria-hidden />
                </button>
                <RefreshBtn onClick={loadStatus} busy={statusBusy} label="به‌روزرسانی نمادها" />
              </>
            }
          >
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input
                className="form-input"
                style={{ padding: '7px 10px', fontSize: 12 }}
                placeholder="نماد جدید (مثلاً SOL)"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
              />
              <button type="button" className="btn btn-success btn-sm" onClick={addSymbol} disabled={symbolBusy || !newSymbol.trim()}>
                <i className="ph ph-plus" aria-hidden />
              </button>
            </div>
            <div style={{ maxHeight: 230, overflowY: 'auto' }}>
              <table className="tb-table" style={{ minWidth: 320 }}>
                <thead>
                  <tr>
                    <th>نماد</th>
                    <th>وضعیت</th>
                    <th>خطا</th>
                    <th>آخرین چرخه</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(status?.symbols ?? []).map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 700 }}>{s.name}</td>
                      <td>
                        <span
                          className={`badge ${s.status === 'waiting' ? 'badge-info' : s.status === 'error' ? 'badge-danger' : 'badge-accent'}`}
                          style={{ fontSize: 10 }}
                        >
                          {s.status === 'waiting' ? 'آماده' : s.status === 'error' ? 'خطا' : 'در حال اجرا'}
                        </span>
                      </td>
                      <td className="num" style={{ color: s.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                        {s.errorCount}
                      </td>
                      <td style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{fmtAgo(s.lastCycleTime)}</td>
                      <td>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeSymbol(s.name)} data-tooltip={`حذف ${s.name}`}>
                          <i className="ph ph-trash" aria-hidden />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              زمان انتظار بین چرخه‌های هر نماد: <span className="num">{status?.tradeWaitTime ?? 60}</span> دقیقه
            </p>
          </PanelCard>

          {/* ============ 5. balance & risk ============ */}
          <PanelCard
            title="موجودی و ریسک"
            icon="ph-fill ph-wallet"
            actions={
              <>
                {balanceMode === 'demo' ? (
                  <span className="demo-pill" style={{ fontSize: 9 }}>
                    <i className="ph-fill ph-flask" aria-hidden /> آزمایشی
                  </span>
                ) : null}
                <RefreshBtn onClick={refreshBalance} busy={balanceBusy} label="به‌روزرسانی موجودی و پوزیشن‌ها" />
              </>
            }
          >
            {balance ? (
              <div className="kpi-grid">
                <div className="kpi-box">
                  <div className="kpi-label">کل دارایی</div>
                  <div className="kpi-value">{fmtUsd(balance.total)}</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">آزاد</div>
                  <div className="kpi-value">{fmtUsd(balance.free)}</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">مارجین در معامله</div>
                  <div className="kpi-value">{fmtUsd(balance.positionMargin)}</div>
                </div>
                <div className="kpi-box">
                  <div className="kpi-label">سود/زیان باز</div>
                  <div className="kpi-value" style={{ color: pnlColor(balance.unrealizedPnL) }}>
                    {fmtUsd(balance.unrealizedPnL)}
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-state" style={{ padding: 18 }}>
                <i className="ph ph-circle-notch spin" aria-hidden />
              </div>
            )}
            <div className="progress-bar" style={{ marginTop: 12 }}>
              <div
                className="progress-fill"
                style={{
                  width: balance && balance.total > 0 ? `${Math.min(100, (balance.positionMargin / balance.total) * 100)}%` : '0%',
                  background: 'linear-gradient(90deg, var(--warning), var(--danger))',
                }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              <span>مارجین در معامله</span>
              <span>
                {balance && balance.total > 0
                  ? `${fmtNum((balance.positionMargin / balance.total) * 100, 1)}٪ از کل`
                  : '—'}
              </span>
            </div>
          </PanelCard>

          {/* ============ 8. logs ============ */}
          <PanelCard
            title="لاگ و عیب‌یابی"
            icon="ph-fill ph-terminal-window"
            actions={
              <>
                <RefreshBtn onClick={loadLogs} busy={logsBusy} label="به‌روزرسانی لاگ‌ها" />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={onRefreshAll}
                  data-tooltip="به‌روزرسانی همه بخش‌ها"
                >
                  <i className="ph ph-database" aria-hidden />
                </button>
              </>
            }
          >
            {logs.length === 0 ? (
              <div className="empty-state" style={{ padding: 18 }}>
                <i className="ph ph-scroll" aria-hidden />
                لاگی ثبت نشده است
              </div>
            ) : (
              <div className="log-timeline" style={{ maxHeight: 320 }}>
                {logs.map((l) => (
                  <div key={l.id} className={`log-tl-item ${l.status.toLowerCase()}`}>
                    <div className="log-tl-msg">
                      {l.symbol ? <b>{l.symbol} · </b> : null}
                      {l.message}
                    </div>
                    <div className="log-tl-time">
                      {fmtDateTime(l.created_at)} · {l.cycleId ? l.cycleId.slice(0, 14) : '—'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </PanelCard>
        </div>
      </div>
    </div>
  )
}
