'use client'

/**
 * Automation view — the MAIN view (mission §7): cycle status, market
 * data & signals, open positions, symbols & scheduling, balance & risk,
 * and the full-width unified log table (mission §3-§7).
 *
 * Data correctness (mission §1.2):
 *  - position PnL amount comes straight from Toobit's `unrealizedPnL`
 *    and `profitRate` is converted ONCE (fraction→percent) inside the
 *    exchange client; fmtPct() receives percent units.
 *  - null fields (exchange did not provide a value) render as «—»
 *    (نامشخص) — never a fabricated zero.
 *  - missing exchange credentials → explicit warning box, no fake data.
 *
 * Sections (each independently refreshable, read endpoints never trade):
 *  1. Cycle status (summary + expandable execution details)
 *  2. content-grid: [market+signals | positions] | [symbols | balance]
 *  3. Log table (full content width, filterable, expandable rows)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import { DataTable, type DataColumn } from '@/modules/common/DataTable'
import { fmtNum, fmtPrice, fmtUsd, fmtPct, fmtTime, fmtDateTime, fmtAgo, fmtQty, pnlColor, shortSymbol } from '@/modules/common/format'
import type { CycleResult, SymbolEntry, OpenPosition, LogRecord, BalanceInfo, Signal, LogStatus } from '@/core/types'

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

/** Log status → coherent Persian label + badge (mission §5). */
const LOG_STATUS_META: Record<LogStatus, { text: string; cls: string }> = {
  SUCCESS: { text: 'موفق', cls: 'badge-success' },
  INFO: { text: 'اطلاع‌رسانی', cls: 'badge-info' },
  SKIPPED: { text: 'رد/ردشده', cls: 'badge-accent' },
  WARNING: { text: 'هشدار', cls: 'badge-warning' },
  ERROR: { text: 'خطا', cls: 'badge-danger' },
}

const SOURCE_LABELS: Record<string, string> = {
  manual: 'دستی',
  cron: 'کرون',
  system: 'سیستم',
}

/** «نامشخص» marker — used whenever the exchange did not send a value. */
const UNKNOWN = '—'

function CredentialsBox() {
  return (
    <div className="badge badge-warning" style={{ width: '100%', justifyContent: 'flex-start', padding: '12px 14px', borderRadius: 12, gap: 8 }}>
      <i className="ph-fill ph-key" aria-hidden />
      <span style={{ textAlign: 'right' }}>
        اعتبارنامه صرافی تنظیم نشده است — برای عملیات حساب و سفارش، کلید API و Secret را در صفحه «تنظیمات» وارد کنید.
      </span>
    </div>
  )
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

interface StatusPayload {
  lastResult: CycleResult | null
  symbols: SymbolEntry[]
  lock: { expiresAt?: number; cycleId?: string } | null
  tradeWaitTime: number
  storage: { reads: number; writes: number; lifetimeReads: number; lifetimeWrites: number }
}

interface AnalysisPayload {
  symbol: string
  interval: string
  lastPrice: number | null
  pendingSignal: (Signal & { status?: string }) | null
  signals: (Signal & { status?: string })[]
  meta: { closedCount: number; candleCount: number }
}

export function AutomationView({ refreshKey, onRefreshAll, onGoChart, onRunCycle, running }: AutomationViewProps) {
  const { show } = useToast()

  const [status, setStatus] = useState<StatusPayload | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)

  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null)
  const [analysisBusy, setAnalysisBusy] = useState(false)
  const [analysisSymbol, setAnalysisSymbol] = useState('BTC')

  const [balance, setBalance] = useState<BalanceInfo | null>(null)
  const [balanceBusy, setBalanceBusy] = useState(false)
  const [credentialsMissing, setCredentialsMissing] = useState(false)

  const [positions, setPositions] = useState<OpenPosition[]>([])
  const [positionsBusy, setPositionsBusy] = useState(false)

  const [logs, setLogs] = useState<LogRecord[]>([])
  const [logsBusy, setLogsBusy] = useState(false)
  const [logSearch, setLogSearch] = useState('')
  const [logSymbol, setLogSymbol] = useState('')
  const [logStatus, setLogStatus] = useState('')
  const [logCycle, setLogCycle] = useState('')
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null)

  const [newSymbol, setNewSymbol] = useState('')
  const [symbolBusy, setSymbolBusy] = useState(false)
  const [closing, setClosing] = useState<string | null>(null)

  const [cycleDetailsOpen, setCycleDetailsOpen] = useState(false)

  /* ---------------- fetchers (dependency-aware) ---------------- */

  const loadStatus = useCallback(async () => {
    setStatusBusy(true)
    try {
      const r = await apiGet<StatusPayload>('/api/automation/status')
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
      const r = await apiGet<AnalysisPayload>(`/api/market/analysis?symbol=${encodeURIComponent(symbol)}`)
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
      const r = await apiGet<{ success: boolean; balance: BalanceInfo | null; code?: string; error?: string }>('/api/account/balance')
      if (r.success && r.balance) {
        setBalance(r.balance)
        setCredentialsMissing(false)
      } else {
        setBalance(null)
        if (r.code === 'NO_CREDENTIALS') {
          setCredentialsMissing(true)
        } else {
          setCredentialsMissing(false)
          show('موجودی', r.error || 'دریافت موجودی ناموفق بود', 'warning')
        }
      }
    } catch (e) {
      setBalance(null)
      show('موجودی', e instanceof Error ? e.message : 'خطا', 'warning')
    } finally {
      setBalanceBusy(false)
    }
  }, [show])

  const loadPositions = useCallback(async () => {
    setPositionsBusy(true)
    try {
      const r = await apiGet<{ success: boolean; positions: OpenPosition[]; code?: string; error?: string }>('/api/positions/open')
      if (r.success) {
        setPositions(r.positions)
      } else if (r.code === 'NO_CREDENTIALS') {
        setPositions([])
      } else {
        show('پوزیشن‌ها', r.error || 'دریافت پوزیشن‌ها ناموفق بود', 'warning')
      }
    } catch (e) {
      show('پوزیشن‌ها', e instanceof Error ? e.message : 'خطا', 'warning')
    } finally {
      setPositionsBusy(false)
    }
  }, [show])

  const loadLogs = useCallback(async () => {
    setLogsBusy(true)
    try {
      const r = await apiGet<{ logs: LogRecord[] }>('/api/diagnostics/logs?limit=200')
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
      const r = await apiPost<{ success: boolean; closed: number; total: number; error?: string }>('/api/positions/close', { symbol: sym, direction })
      show(
        'بستن پوزیشن',
        r.success ? `${sym} ${pos.side === 'LONG' ? 'لانگ' : 'شورت'} بسته شد` : r.error || 'پوزیشنی برای بستن یافت نشد',
        r.success ? 'success' : 'warning'
      )
      refreshPositions()
    } catch (e) {
      show('بستن پوزیشن', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setClosing(null)
    }
  }

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        // fallback for non-secure/legacy contexts (headless tests, http LAN)
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      show('کپی شد', `${label} در حافظه کپی شد`, 'success')
    } catch {
      show('کپی ناموفق', 'مرورگر اجازه دسترسی به حافظه را نداد — شناسه: ' + text, 'info')
    }
  }, [show])

  /* ---------------- derived ---------------- */

  const last = status?.lastResult ?? null
  const actionInfo = last ? ACTION_LABELS[last.action] ?? { text: last.action, cls: 'badge-info' } : null
  const pending = analysis?.pendingSignal ?? null

  const lastRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (last && lastRef.current) lastRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [last?.cycleId])

  /* ---------------- log table (mission §3-§6) ---------------- */

  const distinctSymbols = useMemo(
    () => [...new Set(logs.map((l) => l.symbol).filter((s): s is string => Boolean(s)))].sort(),
    [logs]
  )

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase()
    return logs.filter((l) => {
      if (logSymbol && l.symbol !== logSymbol) return false
      if (logStatus && l.status !== logStatus) return false
      if (logCycle && l.cycleId !== logCycle) return false
      if (q) {
        const hay = `${l.message} ${l.process ?? ''} ${l.action} ${l.symbol ?? ''} ${l.cycleId ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [logs, logSearch, logSymbol, logStatus, logCycle])

  const logHasFilters = Boolean(logSearch || logSymbol || logStatus || logCycle)

  const parseDetails = (d: LogRecord['details']): Record<string, unknown> | null => {
    if (d == null) return null
    if (typeof d === 'object') return d
    try {
      const parsed = JSON.parse(d)
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  const logColumns: DataColumn<LogRecord>[] = [
    {
      key: 'time',
      header: 'زمان',
      width: '120px',
      align: 'end',
      ltr: true,
      render: (l) => <span className="num" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{fmtDateTime(l.created_at)}</span>,
    },
    {
      key: 'symbol',
      header: 'نماد',
      width: '90px',
      align: 'end',
      ltr: true,
      render: (l) =>
        l.symbol ? (
          <bdi style={{ fontWeight: 700 }}>{l.symbol}</bdi>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>{UNKNOWN}</span>
        ),
    },
    {
      key: 'process',
      header: 'فرایند',
      render: (l) => <span style={{ fontWeight: 600, fontSize: 12.5 }}>{l.process ?? (l.action === 'automation_cycle' ? 'چرخه اتوماسیون' : l.action)}</span>,
    },
    {
      key: 'status',
      header: 'وضعیت',
      width: '110px',
      align: 'center',
      render: (l) => {
        const meta = LOG_STATUS_META[l.status] ?? LOG_STATUS_META.INFO
        return (
          <span className={`badge ${meta.cls}`} style={{ fontSize: 10.5 }}>
            {meta.text}
          </span>
        )
      },
    },
    {
      key: 'message',
      header: 'جزئیات',
      render: (l) => (
        <span style={{ fontSize: 12.5, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: 'inline-block', maxWidth: 420, whiteSpace: 'nowrap', verticalAlign: 'middle' }}>{l.message}</span>
          <i className={`ph ${expandedLogId === l.id ? 'ph-caret-up' : 'ph-caret-down'}`} style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
        </span>
      ),
    },
  ]

  const renderLogDetails = (l: LogRecord) => {
    const details = parseDetails(l.details)
    const detailsString = details ? null : (typeof l.details === 'string' ? l.details : null)
    return (
      <div>
        <div className="log-detail-grid">
          <div className="log-detail-item">
            <div className="log-detail-label">پیام</div>
            <div style={{ fontSize: 12.5 }}>{l.message}</div>
          </div>
          <div className="log-detail-item">
            <div className="log-detail-label">شناسه چرخه</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="log-detail-value mono" style={{ fontSize: 11 }}>{l.cycleId ?? UNKNOWN}</span>
              {l.cycleId ? (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(l.cycleId!, 'شناسه چرخه')} data-tooltip="کپی شناسه" aria-label="کپی شناسه چرخه">
                    <i className="ph ph-copy" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => {
                      setLogCycle(l.cycleId!)
                      setExpandedLogId(null)
                    }}
                    data-tooltip="نمایش همه رویدادهای این چرخه"
                  >
                    <i className="ph ph-funnel" aria-hidden />
                  </button>
                </>
              ) : null}
            </div>
          </div>
          <div className="log-detail-item">
            <div className="log-detail-label">منبع</div>
            <div className="log-detail-value" style={{ fontSize: 12.5 }}>{SOURCE_LABELS[l.source ?? 'system'] ?? l.source ?? UNKNOWN}</div>
          </div>
          {l.step != null ? (
            <div className="log-detail-item">
              <div className="log-detail-label">مرحله</div>
              <div className="log-detail-value" style={{ fontSize: 12.5 }}>
                <span className="num">{l.step}</span>
              </div>
            </div>
          ) : null}
          {l.durationMs != null ? (
            <div className="log-detail-item">
              <div className="log-detail-label">مدت اجرا</div>
              <div className="log-detail-value" style={{ fontSize: 12.5 }}>
                <span className="num">{l.durationMs}ms</span>
              </div>
            </div>
          ) : null}
        </div>
        {details ? (
          <div className="log-detail-kv">
            {Object.entries(details).map(([k, v]) => (
              <div className="log-detail-kv-row" key={k}>
                <span className="log-detail-kv-key">{k}</span>
                <span className="log-detail-kv-val">
                  {v == null ? UNKNOWN : typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </span>
              </div>
            ))}
          </div>
        ) : detailsString ? (
          <div className="log-detail-kv">
            <div className="log-detail-kv-row">
              <span className="log-detail-kv-key">توضیح</span>
              <span className="log-detail-kv-val">{detailsString}</span>
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  /* ---------------- positions table columns (mission §1.2) ---------------- */

  const positionColumns: DataColumn<OpenPosition>[] = [
    {
      key: 'symbol',
      header: 'نماد',
      width: '92px',
      ltr: true,
      strong: true,
      render: (p) => (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onGoChart(shortSymbol(p.symbol))}>
          {shortSymbol(p.symbol)}
        </button>
      ),
    },
    {
      key: 'side',
      header: 'جهت',
      width: '76px',
      align: 'center',
      render: (p) => (
        <span className={p.side === 'LONG' ? 'long' : 'short'} style={{ fontWeight: 700 }}>
          {p.side === 'LONG' ? 'لانگ' : 'شورت'}
        </span>
      ),
    },
    {
      key: 'entry',
      header: 'قیمت ورود',
      width: '110px',
      align: 'end',
      ltr: true,
      render: (p) => <span className="mono">{p.entryPrice != null ? fmtPrice(p.entryPrice) : UNKNOWN}</span>,
    },
    {
      key: 'mark',
      header: 'قیمت فعلی',
      width: '110px',
      align: 'end',
      ltr: true,
      render: (p) => <span className="mono">{p.markPrice != null ? fmtPrice(p.markPrice) : UNKNOWN}</span>,
    },
    {
      key: 'qty',
      header: 'مقدار',
      width: '86px',
      align: 'end',
      ltr: true,
      render: (p) => <span className="mono num">{p.qty != null ? fmtQty(p.qty) : UNKNOWN}</span>,
    },
    {
      key: 'leverage',
      header: 'اهرم',
      width: '64px',
      align: 'end',
      ltr: true,
      render: (p) => <span className="mono num">{p.leverage != null ? `${p.leverage}x` : UNKNOWN}</span>,
    },
    {
      key: 'margin',
      header: 'مارجین',
      width: '100px',
      align: 'end',
      ltr: true,
      render: (p) => <span className="mono">{p.margin != null ? fmtUsd(p.margin) : UNKNOWN}</span>,
    },
    {
      key: 'pnl',
      header: 'سود/زیان',
      width: '150px',
      align: 'end',
      ltr: true,
      render: (p) => {
        if (p.unrealizedPnL == null && p.profitRate == null) return <span style={{ color: 'var(--text-muted)' }}>{UNKNOWN}</span>
        return (
          <span className="mono" style={{ color: pnlColor(p.unrealizedPnL) }}>
            {p.unrealizedPnL != null ? fmtUsd(p.unrealizedPnL) : UNKNOWN}{' '}
            <small>({p.profitRate != null ? fmtPct(p.profitRate) : UNKNOWN})</small>
          </span>
        )
      },
    },
    {
      key: 'tpsl',
      header: 'TP / SL',
      width: '150px',
      align: 'end',
      ltr: true,
      render: (p) => (
        <span style={{ fontSize: 11 }} className="mono">
          {p.takeProfit != null ? <span className="long">{fmtPrice(p.takeProfit)}</span> : UNKNOWN} /{' '}
          {p.stopLoss != null ? <span className="short">{fmtPrice(p.stopLoss)}</span> : UNKNOWN}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'عملیات',
      width: '90px',
      align: 'center',
      render: (p) => (
        <button
          type="button"
          className="btn btn-danger btn-sm"
          onClick={() => closePosition(p)}
          disabled={closing === p.symbol + p.side}
          aria-label={`بستن پوزیشن ${shortSymbol(p.symbol)}`}
        >
          <i className={`ph ${closing === p.symbol + p.side ? 'ph-circle-notch spin' : 'ph-x'}`} aria-hidden />
          <span>بستن</span>
        </button>
      ),
    },
  ]

  /* ---------------- symbols table (mission §9) ---------------- */

  const symbolColumns: DataColumn<SymbolEntry>[] = [
    { key: 'name', header: 'نماد', width: '110px', ltr: true, strong: true, render: (s) => s.name },
    {
      key: 'status',
      header: 'وضعیت',
      width: '100px',
      align: 'center',
      render: (s) => (
        <span
          className={`badge ${s.status === 'waiting' ? 'badge-info' : s.status === 'error' ? 'badge-danger' : 'badge-accent'}`}
          style={{ fontSize: 10 }}
        >
          {s.status === 'waiting' ? 'آماده' : s.status === 'error' ? 'خطا' : 'در حال اجرا'}
        </span>
      ),
    },
    {
      key: 'errors',
      header: 'خطا',
      width: '70px',
      align: 'end',
      ltr: true,
      render: (s) => (
        <span className="num" style={{ color: s.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
          {s.errorCount}
        </span>
      ),
    },
    {
      key: 'lastCycle',
      header: 'آخرین چرخه',
      width: '110px',
      align: 'end',
      render: (s) => <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{s.lastCycleTime ? fmtAgo(s.lastCycleTime) : '—'}</span>,
    },
    {
      key: 'remove',
      header: 'عملیات',
      width: '80px',
      align: 'center',
      render: (s) => (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => removeSymbol(s.name)} data-tooltip={`حذف ${s.name}`} aria-label={`حذف ${s.name}`}>
          <i className="ph ph-trash" aria-hidden />
        </button>
      ),
    },
  ]

  /* ---------------- signals table ---------------- */

  const signalColumns: DataColumn<Signal & { status?: string }>[] = [
    {
      key: 'time',
      header: 'زمان',
      width: '120px',
      align: 'end',
      ltr: true,
      render: (s) => <span className="num" style={{ fontSize: 12 }}>{fmtDateTime(s.signalConfirmedAt)}</span>,
    },
    {
      key: 'side',
      header: 'جهت',
      width: '80px',
      align: 'center',
      render: (s) => (
        <span className={s.side === 'Long' ? 'long' : 'short'} style={{ fontWeight: 700 }}>
          {s.side === 'Long' ? 'لانگ' : 'شورت'}
        </span>
      ),
    },
    { key: 'price', header: 'قیمت', width: '110px', align: 'end', ltr: true, render: (s) => <span className="mono">{fmtPrice(s.price)}</span> },
    { key: 'tp', header: 'TP', width: '110px', align: 'end', ltr: true, render: (s) => <span className="mono long">{fmtPrice(s.tp)}</span> },
    { key: 'sl', header: 'SL', width: '110px', align: 'end', ltr: true, render: (s) => <span className="mono short">{fmtPrice(s.sl)}</span> },
    {
      key: 'status',
      header: 'وضعیت',
      width: '100px',
      align: 'center',
      render: (s) => {
        const meta = SIGNAL_STATUS[s.status ?? 'NOT_OPENED']
        return (
          <span className={`badge ${meta.cls}`} style={{ fontSize: 10 }}>
            {meta.text}
          </span>
        )
      },
    },
    {
      key: 'goChart',
      header: 'عملیات',
      width: '70px',
      align: 'center',
      render: (s) => (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onGoChart(shortSymbol(s.symbol))} data-tooltip="نمایش در چارت" aria-label={`نمایش ${shortSymbol(s.symbol)} در چارت`}>
          <i className="ph ph-candlestick-chart" aria-hidden />
        </button>
      ),
    },
  ]

  /* ---------------- render ---------------- */

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ============ 1. cycle status (summary + expandable details, mission §7) ============ */}
      <div ref={lastRef}>
        <PanelCard
          title="وضعیت چرخه"
          icon="ph-fill ph-pulse"
          actions={
            <>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} className="num" title="شمارنده‌های ذخیره‌سازی از آخرین راه‌اندازی">
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
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                <span className={`badge ${actionInfo!.cls}`}>
                  <span className="badge-dot-sm" /> {actionInfo!.text}
                </span>
                <span className="badge badge-accent">
                  <i className="ph ph-clock" aria-hidden /> <span className="num">{(last.durationMs / 1000).toFixed(1)}s</span>
                </span>
                {last.symbol ? (
                  <span className="badge badge-info">
                    <i className="ph ph-coin" aria-hidden /> <bdi>{last.symbol}</bdi>
                  </span>
                ) : null}
                <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                  {last.source === 'cron' ? 'کرون' : 'دستی'} · {fmtDateTime(last.finishedAt)}
                </span>
                {last.storage ? (
                  <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }} title="بودجه ذخیره‌سازی این چرخه">
                    <i className="ph ph-database" aria-hidden /> <span className="num">{last.storage.reads}</span> خواندن ·{' '}
                    <span className="num">{last.storage.writes}</span> نوشتن
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

              {/* expandable execution details (mission §7) — cycleId lives HERE with copy, not in the summary */}
              <div style={{ borderTop: '1px dashed var(--border-soft)', paddingTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCycleDetailsOpen((v) => !v)}
                  aria-expanded={cycleDetailsOpen}
                >
                  <i className={`ph ${cycleDetailsOpen ? 'ph-caret-up' : 'ph-caret-down'}`} aria-hidden />
                  <span>{cycleDetailsOpen ? 'بستن جزئیات اجرا' : 'جزئیات اجرا (مراحل و شناسه چرخه)'}</span>
                </button>

                {cycleDetailsOpen ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>شناسه چرخه:</span>
                      <span className="mono" style={{ fontSize: 11 }}>{last.cycleId}</span>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(last.cycleId, 'شناسه چرخه')} data-tooltip="کپی شناسه" aria-label="کپی شناسه چرخه">
                        <i className="ph ph-copy" aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setLogCycle(last.cycleId)
                          setCycleDetailsOpen(false)
                          document.getElementById('logs-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                        }}
                        data-tooltip="نمایش رویدادهای این چرخه در جدول لاگ"
                      >
                        <i className="ph ph-funnel" aria-hidden />
                        <span>رویدادها در جدول لاگ</span>
                      </button>
                    </div>
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
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <i className="ph ph-pulse" aria-hidden />
              هنوز چرخه‌ای اجرا نشده — با دکمه «یک چرخه» شروع کنید
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={onRunCycle} disabled={running}>
              <i className={`ph ${running ? 'ph-circle-notch spin' : 'ph-play'}`} aria-hidden />
              <span>اجرای یک چرخه</span>
            </button>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              زمان‌بندی اصلی: کرون ابر (هر ۵ دقیقه) — این دکمه همان موتور را اجرا می‌کند
            </span>
          </div>
        </PanelCard>
      </div>

      <div className="content-grid">
        {/* left column: market + signals + positions */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          {/* ============ market data + signals (mission §7-§8) ============ */}
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
                  {(status?.symbols ?? [{ name: 'BTC' } as SymbolEntry, { name: 'ETH' } as SymbolEntry, { name: 'DOT' } as SymbolEntry]).map((s) => (
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
                  {/* FIRST card: selected symbol (mission §7) */}
                  <div className="kpi-box kpi-symbol" title="نماد انتخاب‌شده برای تحلیل">
                    <div className="kpi-symbol-icon">
                      <i className="ph-fill ph-currency-btc" aria-hidden />
                    </div>
                    <div>
                      <div className="kpi-symbol-name">
                        <bdi>{analysis.symbol}</bdi>
                      </div>
                      <div className="kpi-symbol-sub">نماد انتخاب‌شده</div>
                    </div>
                  </div>
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
                    <div className="kpi-value">
                      <bdi>{analysis.interval}</bdi>
                    </div>
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
                      <div style={{ minWidth: 0 }}>
                        <div className="toggle-label">
                          سیگنال آماده: {pending.side === 'Long' ? 'لانگ' : 'شورت'} <bdi>{pending.symbol}</bdi>
                        </div>
                        {/* mission §8 — each label+value is an isolated LTR unit; the row wraps BETWEEN units */}
                        <div className="signal-meta">
                          <span className="signal-meta-chip">
                            ورود <bdi className="num">{fmtPrice(pending.price)}</bdi>
                          </span>
                          <span className="signal-meta-chip">
                            TP <bdi className="num long">{fmtPrice(pending.tp)}</bdi>
                          </span>
                          <span className="signal-meta-chip">
                            SL <bdi className="num short">{fmtPrice(pending.sl)}</bdi>
                          </span>
                          <span className="signal-meta-chip">
                            تأیید <bdi className="num">{fmtDateTime(pending.signalConfirmedAt)}</bdi>
                          </span>
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

                <DataTable
                  label="سیگنال‌های تحلیل‌شده"
                  columns={signalColumns}
                  rows={[...analysis.signals].reverse().slice(0, 12)}
                  rowKey={(s) => s.id}
                  minWidth="600px"
                  maxHeight={280}
                  emptyState={
                    <div className="empty-state" style={{ padding: 18 }}>
                      <i className="ph ph-chart-line-down" aria-hidden />
                      سیگنالی در تاریخچه تحلیل نیست
                    </div>
                  }
                />
              </>
            ) : (
              <div className="empty-state">
                <i className="ph ph-circle-notch spin" aria-hidden />
                در حال دریافت تحلیل…
              </div>
            )}
          </PanelCard>

          {/* ============ open positions (mission §1.2) ============ */}
          <PanelCard
            title={`پوزیشن‌های باز (${positions.length})`}
            icon="ph-fill ph-arrows-down-up"
            actions={<RefreshBtn onClick={refreshPositions} busy={positionsBusy} label="به‌روزرسانی پوزیشن‌ها و موجودی" />}
          >
            {credentialsMissing ? (
              <CredentialsBox />
            ) : positions.length === 0 ? (
              <div className="empty-state">
                <i className="ph ph-inbox" aria-hidden />
                پوزیشن بازی وجود ندارد
              </div>
            ) : (
              <DataTable
                label="پوزیشن‌های باز"
                columns={positionColumns}
                rows={positions}
                rowKey={(p) => p.symbol + p.side}
                minWidth="680px"
                maxHeight={320}
              />
            )}
          </PanelCard>
        </div>

        {/* right column */}
        <div className="side-panel">
          {/* ============ symbols & scheduling (mission §9) ============ */}
          <PanelCard
            title="نمادها و زمان‌بندی"
            icon="ph-fill ph-coins"
            actions={
              <>
                <button type="button" className="btn btn-ghost btn-sm" onClick={clearErrors} data-tooltip="پاکسازی خطاها" aria-label="پاکسازی خطاها">
                  <i className="ph ph-broom" aria-hidden />
                </button>
                <RefreshBtn onClick={loadStatus} busy={statusBusy} label="به‌روزرسانی نمادها" />
              </>
            }
          >
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input
                className="form-input"
                style={{ padding: '7px 10px', fontSize: 12, direction: 'ltr' }}
                placeholder="نماد جدید (مثلاً SOL)"
                value={newSymbol}
                onChange={(e) => setNewSymbol(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
                aria-label="افزودن نماد جدید"
              />
              <button type="button" className="btn btn-success btn-sm" onClick={addSymbol} disabled={symbolBusy || !newSymbol.trim()} aria-label="افزودن نماد">
                <i className="ph ph-plus" aria-hidden />
              </button>
            </div>
            <DataTable
              label="نمادها و زمان‌بندی"
              columns={symbolColumns}
              rows={status?.symbols ?? []}
              rowKey={(s) => String(s.id)}
              minWidth="430px"
              maxHeight={280}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              زمان انتظار بین چرخه‌های هر نماد: <span className="num">{status?.tradeWaitTime ?? 60}</span> دقیقه
            </p>
          </PanelCard>

          {/* ============ balance & risk (mission §14 — explicit credentials state) ============ */}
          <PanelCard
            title="موجودی و ریسک"
            icon="ph-fill ph-wallet"
            actions={<RefreshBtn onClick={refreshBalance} busy={balanceBusy} label="به‌روزرسانی موجودی و پوزیشن‌ها" />}
          >
            {credentialsMissing ? (
              <CredentialsBox />
            ) : balance ? (
              <>
                <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', marginBottom: 0 }}>
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
                <div className="progress-bar" style={{ marginTop: 12 }}>
                  <div
                    className="progress-fill"
                    style={{
                      width: balance.total > 0 ? `${Math.min(100, (balance.positionMargin / balance.total) * 100)}%` : '0%',
                      background: 'linear-gradient(90deg, var(--warning), var(--danger))',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>مارجین در معامله</span>
                  <span>
                    {balance.total > 0 ? (
                      <span className="num">{fmtNum((balance.positionMargin / balance.total) * 100, 1)}٪</span>
                    ) : (
                      UNKNOWN
                    )}{' '}
                    از کل
                  </span>
                </div>
              </>
            ) : (
              <div className="empty-state" style={{ padding: 18 }}>
                <i className="ph ph-circle-notch spin" aria-hidden />
              </div>
            )}
          </PanelCard>
        </div>
      </div>

      {/* ============ log table — FULL content width (mission §3-§6) ============ */}
      <section className="card panel-card" id="logs-panel" aria-label="جدول لاگ و عیب‌یابی">
        <div className="panel-title">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ph-fill ph-terminal-window" aria-hidden /> لاگ و عیب‌یابی{' '}
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              <span className="num">{filteredLogs.length}</span> رویداد
            </span>
          </span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <RefreshBtn onClick={loadLogs} busy={logsBusy} label="به‌روزرسانی لاگ‌ها" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={onRefreshAll} data-tooltip="به‌روزرسانی همه بخش‌ها" aria-label="به‌روزرسانی همه بخش‌ها">
              <i className="ph ph-database" aria-hidden />
            </button>
          </span>
        </div>

        <div className="log-toolbar">
          <input
            className="form-input"
            placeholder="جست‌وجو در پیام، فرایند، نماد یا شناسه چرخه…"
            value={logSearch}
            onChange={(e) => setLogSearch(e.target.value)}
            aria-label="جست‌وجوی متنی در لاگ‌ها"
            style={{ flex: '1 1 220px', minWidth: 160 }}
          />
          <select className="form-input" value={logSymbol} onChange={(e) => setLogSymbol(e.target.value)} aria-label="فیلتر نماد">
            <option value="">همه نمادها</option>
            {distinctSymbols.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className="form-input" value={logStatus} onChange={(e) => setLogStatus(e.target.value)} aria-label="فیلتر وضعیت">
            <option value="">همه وضعیت‌ها</option>
            <option value="SUCCESS">موفق</option>
            <option value="INFO">اطلاع‌رسانی</option>
            <option value="SKIPPED">رد/ردشده</option>
            <option value="WARNING">هشدار</option>
            <option value="ERROR">خطا</option>
          </select>
          {logHasFilters ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setLogSearch('')
                setLogSymbol('')
                setLogStatus('')
                setLogCycle('')
              }}
            >
              <i className="ph ph-x-circle" aria-hidden />
              <span>حذف فیلترها</span>
            </button>
          ) : null}
          {logCycle ? (
            <span className="badge badge-accent" style={{ direction: 'rtl' }}>
              چرخه: <bdi className="mono" style={{ fontSize: 10 }}>{logCycle}</bdi>
              <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => setLogCycle('')} aria-label="حذف فیلتر چرخه">
                <i className="ph ph-x" aria-hidden />
              </button>
            </span>
          ) : null}
        </div>

        <DataTable
          label="رویدادهای لاگ — از جدیدترین به قدیمی‌ترین"
          columns={logColumns}
          rows={filteredLogs}
          rowKey={(l) => String(l.id)}
          minWidth="760px"
          maxHeight={480}
          onRowClick={(l) => setExpandedLogId((cur) => (cur === l.id ? null : l.id))}
          isRowExpanded={(l) => expandedLogId === l.id}
          renderExpanded={renderLogDetails}
          emptyState={
            <div className="empty-state" style={{ padding: 22 }}>
              <i className="ph ph-scroll" aria-hidden />
              {logHasFilters ? 'رویدادی با این فیلترها یافت نشد' : 'لاگی ثبت نشده است'}
            </div>
          }
        />
      </section>
    </div>
  )
}
