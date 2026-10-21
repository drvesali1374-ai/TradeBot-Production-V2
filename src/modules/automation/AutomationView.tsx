'use client'

/**
 * Automation view — the MAIN view (mission §3/§7/§9): ONE unified cycle+log
 * panel, market data & signals, open positions, symbols & scheduling,
 * balance & risk, and the per-symbol stats table.
 *
 * Data correctness (mission §1.2):
 *  - position PnL amount comes straight from Toobit's `unrealizedPnL`
 *    and `profitRate` is converted ONCE (fraction→percent) inside the
 *    exchange client; fmtPct() receives percent units.
 *  - null fields (exchange did not provide a value) render as «—»
 *    (نامشخص) — never a fabricated zero.
 *  - missing exchange credentials → explicit warning box, no fake data.
 *
 * Sections (mission §9 layout):
 *  1. top-grid: [نمادها و زمان‌بندی ~1fr | stats-inpage twin] | [§3 unified
 *     cycle+log panel ~2fr] — stacks full-width ≤1280px
 *  2. market data + signals (full width)
 *  3. open positions (full width)
 *  4. balance & risk (full width)
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import { DataTable, type DataColumn } from '@/modules/common/DataTable'
import { fmtNum, fmtPrice, fmtUsd, fmtPct, fmtDateTime, fmtDurationFa, fmtQty, pnlColor, shortSymbol, fmtUsdtAmount, tpslLabel, type TpslLabel } from '@/modules/common/format'
import type { CycleResult, SymbolEntry, OpenPosition, LogRecord, BalanceInfo, Signal, LogStatus } from '@/core/types'
import { CloseConfirmDialog } from '@/modules/automation/CloseConfirmDialog'
import { SymbolStatsTable, SymbolStatsCoverageNote, type SymbolStatsPayload } from '@/modules/automation/SymbolStatsTable'

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

/**
 * CycleAction → Persian label + badge hue (mission §3.1). Must cover the
 * FULL server union — including the new SIGNAL_ALREADY_OPENED gate.
 */
const ACTION_LABELS: Record<string, { text: string; cls: string }> = {
  NO_READY_SYMBOL: { text: 'نماد آماده نبود', cls: 'badge-info' },
  MARKET_DATA_FAILED: { text: 'خطای داده بازار', cls: 'badge-danger' },
  NO_SIGNAL: { text: 'بدون سیگنال', cls: 'badge-info' },
  SIGNAL_EXPIRED: { text: 'سیگنال منقضی', cls: 'badge-warning' },
  SIGNAL_STALE: { text: 'سیگنال قدیمی', cls: 'badge-warning' },
  SIGNAL_ALREADY_OPENED: { text: 'سیگنال قبلاً باز شده', cls: 'badge-warning' },
  ALREADY_PROCESSED: { text: 'قبلاً پردازش شده', cls: 'badge-info' },
  RISK_REJECTED: { text: 'رد توسط ریسک', cls: 'badge-warning' },
  POSITION_OPENED: { text: 'پوزیشن باز شد', cls: 'badge-success' },
  POSITION_OPENED_TPSL_FAILED: { text: 'باز شد — TP/SL خطا', cls: 'badge-warning' },
  OPPOSITE_CLOSED_THEN_OPENED: { text: 'مخالف بسته + باز شد', cls: 'badge-success' },
  ERROR: { text: 'خطا', cls: 'badge-danger' },
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

/**
 * One TP/SL table line (mission §2.2 — tri-state, never conflated):
 *  - 'price'   → real stop-order price → TP green (long) / SL red (short),
 *               same hues as the signals table TP/SL columns
 *  - 'unset'   → read-back OK + no order → «تنظیم نشده» (muted)
 *  - 'unknown' → read-back FAILED → «نامشخص» (warning-ish) + tooltip why
 */
function TpslLine({ label, info, hue }: { label: string; info: TpslLabel; hue: 'long' | 'short' }) {
  if (info.kind === 'unknown') {
    return (
      <span style={{ color: 'var(--warning)', opacity: 0.85 }} title="دریافت TP/SL از صرافی ناموفق بود">
        {label}: {info.text}
      </span>
    )
  }
  if (info.kind === 'unset') {
    return (
      <span style={{ color: 'var(--text-muted)' }}>
        {label}: {info.text}
      </span>
    )
  }
  return (
    <span className={hue}>
      {label}: {info.text}
    </span>
  )
}

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
  /** Per-symbol closed-trade stats (mission §8-UI) — fetched by the shell. */
  symbolStats: SymbolStatsPayload | null
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

export function AutomationView({ refreshKey, onRefreshAll, onGoChart, onRunCycle, running, symbolStats }: AutomationViewProps) {
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
  // close-confirm flow (mission §1.1): the row «بستن» button ONLY selects a
  // target — the CloseConfirmDialog is the single gate that may fire the
  // real POST /api/positions/close (via onConfirm below).
  const [closeTarget, setCloseTarget] = useState<OpenPosition | null>(null)
  const [closeSubmitting, setCloseSubmitting] = useState(false)

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

  /** The ONLY network-triggering path — called by the dialog's «بستن پوزیشن». */
  const closePosition = async (pos: OpenPosition) => {
    if (closeSubmitting) return // double-submit guard (dialog disables too)
    const sym = shortSymbol(pos.symbol)
    const direction = pos.side === 'LONG' ? 'long' : 'short'
    setCloseSubmitting(true)
    try {
      const r = await apiPost<{
        success: boolean
        closed: number
        total: number
        error?: string
        errors?: string[]
      }>('/api/positions/close', { symbol: sym, direction })
      if (r.success) {
        show('بستن پوزیشن', `${r.closed} پوزیشن بسته شد`, 'success')
      } else {
        // the REAL server reason — never a generic fallback while the
        // server sent anything (errors[] joined, else error message)
        const detail = [r.error, ...(r.errors ?? [])].filter(Boolean).join(' — ')
        show('بستن پوزیشن', detail || 'پوزیشنی برای بستن یافت نشد', 'warning')
      }
      refreshPositions()
    } catch (e) {
      show('بستن پوزیشن', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setCloseSubmitting(false)
      setCloseTarget(null)
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

  /** step counts for the §3.1 summary header (from the SAME steps the server persisted as log rows) */
  const stepCounts = useMemo(() => {
    if (!last) return null
    let ok = 0
    let warn = 0
    let fail = 0
    for (const s of last.steps) {
      if (s.status === 'ok') ok += 1
      else if (s.status === 'warning') warn += 1
      else if (s.status === 'failed') fail += 1
    }
    return { ok, warn, fail }
  }, [last])

  /* ---------------- unified cycle+log table (mission §3) ---------------- */

  const distinctSymbols = useMemo(
    () => [...new Set(logs.map((l) => l.symbol).filter((s): s is string => Boolean(s)))].sort(),
    [logs]
  )

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase()
    const out = logs.filter((l) => {
      if (logSymbol && l.symbol !== logSymbol) return false
      if (logStatus && l.status !== logStatus) return false
      if (logCycle && l.cycleId !== logCycle) return false
      if (q) {
        const hay = `${l.message} ${l.process ?? ''} ${l.action} ${l.symbol ?? ''} ${l.cycleId ?? ''}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    // mission §3.3: with a single-cycle filter active, show that cycle's
    // rows in EXECUTION order — the persisted `step` ordinal is the single
    // source of truth (created_at only as tiebreaker). No UI whims.
    if (logCycle) {
      return [...out].sort(
        (a, b) =>
          (a.step ?? Number.MAX_SAFE_INTEGER) - (b.step ?? Number.MAX_SAFE_INTEGER) ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      )
    }
    return out // newest-first (server merge order) — never re-sorted by the UI
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

  /**
   * Unified event table (mission §3.2) — cycle-level rows and step-level
   * rows come from THE SAME data source: the persisted LogRecords (every
   * step IS a log row with its cycleId). No synthetic cycle rows are added
   * on top — a row whose cycleId === lastResult.cycleId belongs to the
   * «چرخه جاری» and gets the subtle accent + badge.
   */
  const logColumns: DataColumn<LogRecord>[] = [
    {
      key: 'time',
      header: 'زمان',
      width: '126px',
      align: 'end',
      ltr: true,
      render: (l) => <span className="num" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{fmtDateTime(l.created_at)}</span>,
    },
    {
      key: 'symbol',
      header: 'نماد',
      width: '58px',
      align: 'end',
      ltr: true,
      render: (l) =>
        l.symbol ? (
          <bdi style={{ fontWeight: 700, fontSize: 11.5 }}>{l.symbol}</bdi>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>{UNKNOWN}</span>
        ),
    },
    {
      key: 'process',
      header: 'فرایند/مرحله',
      width: '100px',
      render: (l) => {
        const text = l.process ?? (l.action === 'automation_cycle' ? 'چرخه اتوماسیون' : l.action)
        return (
          <span style={{ fontWeight: 600, fontSize: 11.5, display: 'flex', minWidth: 0 }} title={text}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{text}</span>
          </span>
        )
      },
    },
    {
      key: 'status',
      header: 'وضعیت',
      width: '74px',
      align: 'center',
      render: (l) => {
        const meta = LOG_STATUS_META[l.status] ?? LOG_STATUS_META.INFO
        return (
          <span className={`badge ${meta.cls}`} style={{ fontSize: 9.5, padding: '2px 7px' }}>
            {meta.text}
          </span>
        )
      },
    },
    {
      key: 'message',
      header: 'جزئیات',
      render: (l) => (
        <span style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={l.message}>
            {l.message}
          </span>
          <i className={`ph ${expandedLogId === l.id ? 'ph-caret-up' : 'ph-caret-down'}`} style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
        </span>
      ),
    },
    {
      key: 'cycleId',
      header: 'شناسه چرخه',
      width: '78px',
      align: 'end',
      ltr: true,
      render: (l) =>
        l.cycleId ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm mono"
            style={{ padding: '2px 4px', fontSize: 10, direction: 'ltr' }}
            onClick={(e) => {
              e.stopPropagation() // row click toggles expand — keep them separate
              copyText(l.cycleId!, 'شناسه چرخه')
            }}
            title={`کپی شناسه کامل: ${l.cycleId}`}
            aria-label={`کپی شناسه چرخه ${l.cycleId}`}
          >
            {l.cycleId.slice(0, 8)}…
          </button>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>{UNKNOWN}</span>
        ),
    },
  ]

  const renderLogDetails = (l: LogRecord) => {
    const details = parseDetails(l.details)
    const detailsString = details ? null : (typeof l.details === 'string' ? l.details : null)
    const isCurrentCycle = Boolean(l.cycleId && last && l.cycleId === last.cycleId)
    return (
      <div>
        <div className="log-detail-grid">
          <div className="log-detail-item">
            <div className="log-detail-label">پیام</div>
            <div style={{ fontSize: 12.5 }}>{l.message}</div>
          </div>
          <div className="log-detail-item">
            <div className="log-detail-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              شناسه چرخه
              {isCurrentCycle ? (
                <span className="badge badge-accent" style={{ fontSize: 9.5, padding: '1px 7px' }}>چرخه جاری</span>
              ) : null}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="log-detail-value mono" style={{ fontSize: 11 }}>{l.cycleId ?? UNKNOWN}</span>
              {/* mission §3.4: the per-row funnel filter is GONE — the GLOBAL
                  funnel (summary header + toolbar chip) is the one filter entry. */}
              {l.cycleId ? (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(l.cycleId!, 'شناسه چرخه')} title="کپی شناسه" aria-label="کپی شناسه چرخه">
                  <i className="ph ph-copy" aria-hidden />
                </button>
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
              <div className="log-detail-value" style={{ fontSize: 12.5 }}>{fmtDurationFa(l.durationMs)}</div>
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
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => onGoChart(shortSymbol(p.symbol))}
          title={`نمایش ${shortSymbol(p.symbol)} در چارت`}
          aria-label={`نمایش ${shortSymbol(p.symbol)} در چارت`}
        >
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
        // mission §1.2 (inverted per spec): PERCENT is the primary/larger
        // figure; the USDT amount is the secondary, smaller (opacity ~0.8)
        // same-hue detail in parentheses. Both null → `— (—)` all muted.
        if (p.unrealizedPnL == null && p.profitRate == null) {
          return (
            <span style={{ color: 'var(--text-muted)' }}>
              {UNKNOWN} ({UNKNOWN})
            </span>
          )
        }
        return (
          <span className="mono" style={{ color: pnlColor(p.unrealizedPnL) }}>
            {p.profitRate != null ? fmtPct(p.profitRate) : UNKNOWN}{' '}
            <small style={{ opacity: 0.8 }}>
              (<bdi className="num">{p.unrealizedPnL != null ? `${fmtUsdtAmount(p.unrealizedPnL)} USDT` : UNKNOWN}</bdi>)
            </small>
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
      render: (p) => {
        // mission §2-UI: two stacked tri-state lines (never «— / —» blindly)
        const tp = tpslLabel(p.takeProfit, p.tpslStatus)
        const sl = tpslLabel(p.stopLoss, p.tpslStatus)
        return (
          <span
            className="mono"
            style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, fontSize: 11 }}
          >
            <TpslLine label="TP" info={tp} hue="long" />
            <TpslLine label="SL" info={sl} hue="short" />
          </span>
        )
      },
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
          onClick={() => setCloseTarget(p)}
          title={`بستن پوزیشن ${shortSymbol(p.symbol)}`}
          aria-label={`بستن پوزیشن ${shortSymbol(p.symbol)}`}
        >
          <i className="ph ph-x" aria-hidden />
          <span>بستن</span>
        </button>
      ),
    },
  ]

  /* ---------------- symbols table (mission §9.2 — compact, fits the 1/3 panel) ---------------- */

  /**
   * Two-line Jalali datetime cell: the SINGLE fmtDateTime value, split at
   * its «, » separator so the column stays ~78px wide inside the 1fr
   * top-grid panel — the symbols table must NOT h-scroll at desktop widths.
   * Both lines are nowrap; when the panel is very narrow the value stays
   * intact (no mid-token break). Plain render fn (not a component) so rows
   * don't remount on every view render.
   */
  const renderCellDateTime = (value: number | null) => {
    const text = fmtDateTime(value)
    if (text === UNKNOWN || !text.includes(', ')) {
      return <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'inline-block' }}>{text}</span>
    }
    const [date, time] = text.split(', ')
    return (
      <span style={{ fontSize: 10, color: 'var(--text-muted)', display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.5 }} title={text}>
        <span style={{ whiteSpace: 'nowrap' }}>{date}،</span>
        <span style={{ whiteSpace: 'nowrap' }}>{time}</span>
      </span>
    )
  }

  const symbolColumns: DataColumn<SymbolEntry>[] = [
    { key: 'name', header: 'نماد', width: '50px', ltr: true, strong: true, render: (s) => <bdi style={{ fontSize: 11.5 }}>{s.name}</bdi> },
    {
      key: 'status',
      header: 'وضعیت',
      width: '58px',
      align: 'center',
      render: (s) => {
        const meta =
          s.status === 'waiting'
            ? { text: 'آماده', cls: 'badge-info', full: 'آماده' }
            : s.status === 'error'
              ? { text: 'خطا', cls: 'badge-danger', full: 'خطا' }
              : { text: 'در اجرا', cls: 'badge-accent', full: 'در حال اجرا' }
        return (
          <span className={`badge ${meta.cls}`} style={{ fontSize: 9, padding: '2px 6px' }} title={meta.full}>
            {meta.text}
          </span>
        )
      },
    },
    {
      key: 'errors',
      header: 'خطا',
      width: '34px',
      align: 'end',
      ltr: true,
      render: (s) => (
        <span className="num" style={{ color: s.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)', fontSize: 11 }}>
          {s.errorCount}
        </span>
      ),
    },
    {
      key: 'lastCycle',
      header: 'آخرین چرخه',
      width: '78px',
      align: 'end',
      // mission §9.2 — full Jalali datetime (with seconds), wrapped to two
      // lines so the compact table fits its 1/3 panel without h-scroll
      render: (s) => renderCellDateTime(s.lastCycleTime),
    },
    {
      key: 'remove',
      header: 'عملیات',
      width: '42px',
      align: 'center',
      render: (s) => (
        <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '4px 5px' }} onClick={() => removeSymbol(s.name)} title={`حذف ${s.name}`} aria-label={`حذف ${s.name}`}>
          <i className="ph ph-trash" style={{ fontSize: 13 }} aria-hidden />
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
      {/* ============ §9 top grid: [symbols ~1/3] | [unified cycle+log ~2/3] ============ */}
      <div className="top-grid">
        {/* grid first column (renders RIGHT in RTL) — symbols & scheduling */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
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
              compact
              fixed
              minWidth="240px"
              maxHeight={280}
            />
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              زمان انتظار بین چرخه‌های هر نماد: <span className="num">{status?.tradeWaitTime ?? 60}</span> دقیقه
            </p>
          </PanelCard>

          {/* §8-UI — the in-page twin of the sidebar stats table: rendered
              only while the sidebar is off-canvas (≤1024px, CSS .stats-inpage).
              On desktop the SIDEBAR carries the stats — never both at once. */}
          <PanelCard
            className="stats-inpage"
            title="آمار معاملات نمادها"
            icon="ph-fill ph-chart-bar"
            actions={<RefreshBtn onClick={onRefreshAll} label="به‌روزرسانی آمار معاملات" />}
          >
            <SymbolStatsTable stats={symbolStats} variant="panel" label="آمار معاملات نمادها" />
            <SymbolStatsCoverageNote stats={symbolStats} />
          </PanelCard>
        </div>

        {/* grid second column (~2/3) — §3 ONE unified cycle+log panel:
            compact summary of the last cycle ABOVE the unified event table.
            The table's rows ARE the persisted steps (same data source) —
            cycle-level info lives in the summary, steps live in the rows. */}
        <section className="card panel-card" id="logs-panel" aria-label="چرخه و رویدادها">
          <div className="panel-title">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ph-fill ph-pulse" aria-hidden /> چرخه و رویدادها{' '}
              <span className="badge badge-info" style={{ fontSize: 10 }}>
                <span className="num">{filteredLogs.length}</span> رویداد
              </span>
            </span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }} className="num" title="شمارنده‌های ذخیره‌سازی از آخرین راه‌اندازی">
                R:{status?.storage.lifetimeReads ?? 0} / W:{status?.storage.lifetimeWrites ?? 0}
              </span>
              <RefreshBtn onClick={() => { loadStatus(); loadLogs() }} busy={statusBusy || logsBusy} label="به‌روزرسانی وضعیت چرخه و رویدادها" />
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRefreshAll} data-tooltip="به‌روزرسانی همه بخش‌ها" aria-label="به‌روزرسانی همه بخش‌ها">
                <i className="ph ph-database" aria-hidden />
              </button>
            </span>
          </div>

          {/* §3.1 compact summary header — last cycle's outcome/times/duration/
              symbol/step counts + per-cycle storage budget + the run button.
              «جزئیات اجرا» (funnel) applies the cycleId filter to the table
              below — one click shows that cycle's steps in execution order. */}
          <div className="cycle-summary">
            {running ? (
              <div className="empty-state pulse-soft" style={{ padding: 12 }}>
                <i className="ph-fill ph-circle-notch spin" aria-hidden />
                چرخه در حال اجراست…
              </div>
            ) : last ? (
              <>
                <div className="cycle-summary-grid">
                  <span className="cycle-chip">
                    <span className="cycle-chip-label">نتیجه نهایی</span>
                    <span className={`badge ${actionInfo!.cls}`} style={{ fontSize: 10.5 }}>
                      <span className="badge-dot-sm" /> {actionInfo!.text}
                    </span>
                  </span>
                  {last.symbol ? (
                    <span className="cycle-chip">
                      <span className="cycle-chip-label">نماد</span>
                      <bdi style={{ fontWeight: 700, fontSize: 12 }}>{last.symbol}</bdi>
                    </span>
                  ) : null}
                  <span className="cycle-chip">
                    <span className="cycle-chip-label">شروع</span>
                    <span style={{ fontSize: 11 }}>{fmtDateTime(last.startedAt)}</span>
                  </span>
                  <span className="cycle-chip">
                    <span className="cycle-chip-label">پایان</span>
                    <span style={{ fontSize: 11 }}>{fmtDateTime(last.finishedAt)}</span>
                  </span>
                  <span className="cycle-chip">
                    <span className="cycle-chip-label">مدت اجرا</span>
                    <b style={{ fontSize: 11.5 }}>{fmtDurationFa(last.durationMs)}</b>
                  </span>
                  {stepCounts ? (
                    <span className="cycle-chip" title="تعداد مراحل این چرخه بر اساس وضعیت">
                      <span className="cycle-chip-label">مراحل</span>
                      <span style={{ fontSize: 11 }}>
                        موفق <b className="num" style={{ color: 'var(--success)' }}>{stepCounts.ok}</b> · هشدار{' '}
                        <b className="num" style={{ color: 'var(--warning)' }}>{stepCounts.warn}</b> · خطا{' '}
                        <b className="num" style={{ color: 'var(--danger)' }}>{stepCounts.fail}</b>
                      </span>
                    </span>
                  ) : null}
                  {last.storage ? (
                    <span className="cycle-chip" title="بودجه ذخیره‌سازی این چرخه">
                      <span className="cycle-chip-label">بودجه ذخیره‌سازی</span>
                      <span style={{ fontSize: 11 }}>
                        <span className="num">{last.storage.reads}</span> خواندن ·{' '}
                        <span className="num">{last.storage.writes}</span> نوشتن
                      </span>
                    </span>
                  ) : null}
                  <span className="cycle-chip">
                    <span className="cycle-chip-label">منبع</span>
                    <span style={{ fontSize: 11 }}>{SOURCE_LABELS[last.source] ?? last.source}</span>
                  </span>
                </div>

                {last.error ? (
                  <div className="badge badge-danger" style={{ width: '100%', justifyContent: 'flex-start', padding: '8px 12px', borderRadius: 10, marginBottom: 8 }}>
                    <i className="ph-fill ph-warning-circle" aria-hidden /> {last.error}
                  </div>
                ) : null}
                {last.reason ? (
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0, marginBottom: 8 }}>
                    علت: <b>{last.reason}</b>
                  </p>
                ) : null}

                <div className="cycle-summary-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={onRunCycle}
                    disabled={running}
                    data-tooltip="زمان‌بندی اصلی: کرون ابر (هر ۵ دقیقه) — این دکمه همان موتور را اجرا می‌کند"
                  >
                    <i className={`ph ${running ? 'ph-circle-notch spin' : 'ph-play'}`} aria-hidden />
                    <span>اجرای یک چرخه</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => {
                      setLogCycle(last.cycleId)
                      setExpandedLogId(null)
                      document.getElementById('unified-table')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                    }}
                    data-tooltip="نمایش رویدادهای این چرخه در جدول زیرین (به ترتیب اجرا)"
                    aria-label={`نمایش رویدادهای چرخه ${last.cycleId} در جدول`}
                  >
                    <i className="ph ph-funnel" aria-hidden />
                    <span>جزئیات اجرا ({last.steps.length} مرحله)</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => copyText(last.cycleId, 'شناسه چرخه')}
                    data-tooltip={`کپی شناسه چرخه: ${last.cycleId}`}
                    aria-label="کپی شناسه چرخه"
                  >
                    <i className="ph ph-copy" aria-hidden />
                    <span className="mono" style={{ fontSize: 10, direction: 'ltr' }}>{last.cycleId.slice(0, 8)}…</span>
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="empty-state" style={{ padding: 10 }}>
                  <i className="ph ph-pulse" aria-hidden />
                  هنوز چرخه‌ای اجرا نشده است
                </div>
                <div className="cycle-summary-actions">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={onRunCycle}
                    disabled={running}
                    data-tooltip="زمان‌بندی اصلی: کرون ابر (هر ۵ دقیقه) — این دکمه همان موتور را اجرا می‌کند"
                  >
                    <i className={`ph ${running ? 'ph-circle-notch spin' : 'ph-play'}`} aria-hidden />
                    <span>اجرای یک چرخه</span>
                  </button>
                </div>
              </>
            )}
          </div>

          {/* §3.4 filters toolbar — free-text search, symbol, status, and the
              removable GLOBAL cycleId funnel chip (the only funnel entry) */}
          <div className="log-toolbar">
            <input
              className="form-input"
              placeholder="جست‌وجو در پیام، فرایند، نماد یا شناسه چرخه…"
              value={logSearch}
              onChange={(e) => setLogSearch(e.target.value)}
              aria-label="جست‌وجوی متنی در رویدادها"
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
              <span className="badge badge-accent" style={{ direction: 'rtl' }} title={logCycle}>
                چرخه: <bdi className="mono" style={{ fontSize: 10 }}>{logCycle.slice(0, 12)}…</bdi>
                <button type="button" className="btn btn-ghost btn-sm" style={{ padding: '0 4px' }} onClick={() => setLogCycle('')} aria-label="حذف فیلتر چرخه" data-tooltip="حذف فیلتر چرخه">
                  <i className="ph ph-x" aria-hidden />
                </button>
              </span>
            ) : null}
          </div>

          {/* §3.2 ONE unified event table — max-height scroll + sticky thead;
              current-cycle rows carry the subtle accent (rowClassName) */}
          <div id="unified-table">
            <DataTable
              label="رویدادهای چرخه و لاگ"
              columns={logColumns}
              rows={filteredLogs}
              rowKey={(l) => String(l.id)}
              compact
              fixed
              minWidth="560px"
              maxHeight={480}
              onRowClick={(l) => setExpandedLogId((cur) => (cur === l.id ? null : l.id))}
              isRowExpanded={(l) => expandedLogId === l.id}
              renderExpanded={renderLogDetails}
              rowClassName={(l) => (l.cycleId && l.cycleId === last?.cycleId ? 'tb-row-current' : undefined)}
              emptyState={
                <div className="empty-state" style={{ padding: 22 }}>
                  <i className="ph ph-scroll" aria-hidden />
                  {logHasFilters ? 'رویدادی با این فیلترها یافت نشد' : 'لاگی ثبت نشده است'}
                </div>
              }
            />
          </div>
        </section>
      </div>

      {/* ============ market data + signals (mission §7-§8) — full width below the top grid ============ */}
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

      {/* ============ balance & risk (mission §14 — explicit credentials state) — full width below ============ */}
      <PanelCard
        title="موجودی و ریسک"
        icon="ph-fill ph-wallet"
        actions={<RefreshBtn onClick={refreshBalance} busy={balanceBusy} label="به‌روزرسانی موجودی و پوزیشن‌ها" />}
      >
        {credentialsMissing ? (
          <CredentialsBox />
        ) : balance ? (
          <>
            <div className="kpi-grid kpi-grid-4" style={{ marginBottom: 0 }}>
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

      {/* ============ close-confirm gate (mission §1.1) ============ */}
      {/* The ONLY trigger of POST /api/positions/close. Escape / backdrop /
          «انصراف» just clear the target — zero network activity. */}
      <CloseConfirmDialog
        position={closeTarget}
        submitting={closeSubmitting}
        onConfirm={() => {
          if (closeTarget) void closePosition(closeTarget)
        }}
        onOpenChange={(open) => {
          // opening is driven ONLY by the row «بستن» buttons (setCloseTarget)
          if (open) return
          // veto Escape / backdrop / «انصراف» while the close POST is in flight
          if (closeSubmitting) return
          setCloseTarget(null)
        }}
      />
    </div>
  )
}
