'use client'

/**
 * Dashboard view — portfolio overview: KPI cards, positions, closed
 * history + stats, recent activity (cycle logs). Read-only panels with
 * individual refresh (refresh never trades).
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import { fmtNum, fmtPrice, fmtUsd, fmtPct, fmtAgo, fmtDateTime, pnlColor, shortSymbol } from '@/modules/common/format'
import type { BalanceInfo, OpenPosition, ClosedPosition, LogRecord, CycleResult } from '@/core/types'

interface HistoryResponse {
  history: ClosedPosition[]
  stats: { total: number; winning: number; losing: number; totalPnl: number } | null
  mode: 'live' | 'demo'
}

function StatCard({
  icon,
  iconBg,
  iconColor,
  value,
  label,
  trend,
  trendCls,
  spark,
  valueColor,
}: {
  icon: string
  iconBg: string
  iconColor: string
  value: string
  label: string
  trend?: string
  trendCls?: string
  spark?: { color: string; points: string }
  valueColor?: string
}) {
  return (
    <div className="card stat-card">
      <div className="stat-top">
        <div className="stat-icon" style={{ background: iconBg, color: iconColor }}>
          <i className={icon} aria-hidden />
        </div>
        {trend ? <div className={`stat-trend ${trendCls ?? 'trend-neutral'}`}>{trend}</div> : null}
      </div>
      <div>
        <div className="stat-value" style={valueColor ? { color: valueColor } : undefined}>{value}</div>
        <div className="stat-label">{label}</div>
      </div>
      {spark ? (
        <svg className="sparkline" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden>
          <path d={spark.points} fill="none" stroke={spark.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </div>
  )
}

interface DashboardViewProps {
  refreshKey: number
  onGoChart: (symbol: string) => void
  onRunCycle: () => void
  running: boolean
}

export function DashboardView({ refreshKey, onGoChart, onRunCycle, running }: DashboardViewProps) {
  const { show } = useToast()
  const [balance, setBalance] = useState<BalanceInfo | null>(null)
  const [mode, setMode] = useState<'live' | 'demo'>('demo')
  const [positions, setPositions] = useState<OpenPosition[]>([])
  const [history, setHistory] = useState<HistoryResponse | null>(null)
  const [logs, setLogs] = useState<LogRecord[]>([])
  const [lastCycle, setLastCycle] = useState<CycleResult | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [closing, setClosing] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setBusy('all')
    const [b, p, h, l, s] = await Promise.allSettled([
      apiGet<{ balance: BalanceInfo; mode: 'live' | 'demo' }>('/api/account/balance'),
      apiGet<{ positions: OpenPosition[] }>('/api/positions/open'),
      apiGet<HistoryResponse>('/api/diagnostics/history'),
      apiGet<{ logs: LogRecord[] }>('/api/diagnostics/logs?limit=12'),
      apiGet<{ lastResult: CycleResult | null }>('/api/automation/status'),
    ])
    if (b.status === 'fulfilled') {
      setBalance(b.value.balance)
      setMode(b.value.mode)
    }
    if (p.status === 'fulfilled') setPositions(p.value.positions)
    if (h.status === 'fulfilled') setHistory(h.value)
    if (l.status === 'fulfilled') setLogs(l.value.logs)
    if (s.status === 'fulfilled') setLastCycle(s.value.lastResult)
    setBusy(null)
  }, [])

  useEffect(() => {
    loadAll()
  }, [refreshKey, loadAll])

  // auto refresh every 30s (read-only polling, never trades)
  useEffect(() => {
    const t = setInterval(loadAll, 30_000)
    return () => clearInterval(t)
  }, [loadAll])

  const closePos = async (pos: OpenPosition) => {
    setClosing(pos.symbol + pos.side)
    try {
      const r = await apiPost<{ success: boolean; closed: number }>('/api/positions/close', {
        symbol: shortSymbol(pos.symbol),
        direction: pos.side === 'LONG' ? 'long' : 'short',
      })
      show('بستن پوزیشن', r.success ? `${shortSymbol(pos.symbol)} بسته شد` : 'پوزیشنی یافت نشد', r.success ? 'success' : 'warning')
      loadAll()
    } catch (e) {
      show('بستن پوزیشن', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setClosing(null)
    }
  }

  const stats = history?.stats
  const unrealized = balance?.unrealizedPnL ?? 0
  const winRate = stats && stats.total > 0 ? (stats.winning / stats.total) * 100 : 0
  const equity = balance ? balance.total : 0
  const pnlTotal = (stats?.totalPnl ?? 0) + unrealized

  return (
    <div>
      <section className="stats-grid">
        <StatCard
          icon="ph-fill ph-wallet"
          iconBg="var(--accent-soft)"
          iconColor="var(--accent)"
          value={fmtUsd(equity)}
          label="ارزش کل حساب"
          trend={mode === 'demo' ? 'آزمایشی' : 'زنده'}
          trendCls="trend-neutral"
          spark={{ color: 'var(--accent)', points: 'M0,22 L12,18 L24,20 L36,12 L48,15 L60,8 L72,11 L84,5 L100,3' }}
        />
        <StatCard
          icon="ph-fill ph-piggy-bank"
          iconBg="var(--success-soft)"
          iconColor="var(--success)"
          value={fmtUsd(pnlTotal)}
          label="سود/زیان کل (باز + بسته)"
          trend={fmtPct(unrealized)}
          trendCls={unrealized >= 0 ? 'trend-up' : 'trend-down'}
          valueColor={pnlColor(pnlTotal)}
          spark={{ color: 'var(--success)', points: 'M0,20 L14,18 L28,22 L42,14 L56,16 L70,9 L84,12 L100,4' }}
        />
        <StatCard
          icon="ph-fill ph-arrows-down-up"
          iconBg="var(--warning-soft)"
          iconColor="var(--warning)"
          value={String(positions.length)}
          label="پوزیشن‌های باز"
          trend={balance ? `${fmtNum((balance.positionMargin / Math.max(balance.total, 1)) * 100, 1)}٪ مارجین` : undefined}
          trendCls="trend-neutral"
        />
        <StatCard
          icon="ph-fill ph-trophy"
          iconBg="#fce7f3"
          iconColor="#ec4899"
          value={`${fmtNum(winRate, 1)}٪`}
          label="نرخ برد"
          trend={stats ? `${stats.total} معامله` : undefined}
          trendCls={winRate >= 50 ? 'trend-up' : 'trend-down'}
          spark={{ color: '#ec4899', points: 'M0,10 L16,14 L32,8 L48,16 L64,12 L80,18 L100,15' }}
        />
      </section>

      <div className="content-grid">
        {/* open positions */}
        <section className="card table-card">
          <div className="table-header">
            <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              <i className="ph-fill ph-arrows-down-up" style={{ color: 'var(--accent)' }} aria-hidden /> پوزیشن‌های باز
              {positions.length ? <span className="badge badge-accent">{positions.length}</span> : null}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadAll} disabled={busy === 'all'}>
              <i className={`ph ${busy === 'all' ? 'ph-circle-notch spin' : 'ph-arrows-clockwise'}`} aria-hidden /> <span>بروزرسانی</span>
            </button>
          </div>
          {positions.length === 0 ? (
            <div className="empty-state">
              <i className="ph ph-inbox" aria-hidden />
              پوزیشن بازی وجود ندارد — اولین چرخه را اجرا کنید
              <div style={{ marginTop: 14 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={onRunCycle} disabled={running}>
                  <i className={`ph ${running ? 'ph-circle-notch spin' : 'ph-play'}`} aria-hidden /> <span>یک چرخه</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="table-container">
              <table className="tb-table">
                <thead>
                  <tr>
                    <th>نماد</th>
                    <th>جهت</th>
                    <th>قیمت ورود</th>
                    <th>قیمت فعلی</th>
                    <th>مقدار</th>
                    <th>مارجین</th>
                    <th>سود/زیان</th>
                    <th style={{ textAlign: 'left' }}>عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p) => (
                    <tr key={p.symbol + p.side} onClick={() => onGoChart(shortSymbol(p.symbol))}>
                      <td>
                        <div className="asset-info">
                          <div
                            className="asset-logo"
                            style={{
                              background: p.side === 'LONG' ? 'var(--success-soft)' : 'var(--danger-soft)',
                              color: p.side === 'LONG' ? 'var(--success)' : 'var(--danger)',
                            }}
                          >
                            {shortSymbol(p.symbol).slice(0, 2)}
                          </div>
                          <div>
                            <div className="asset-name">{shortSymbol(p.symbol)}</div>
                            <div className="asset-pair">{p.leverage}x · {p.symbol}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${p.side === 'LONG' ? 'badge-success' : 'badge-danger'}`}>
                          <span className="badge-dot-sm" /> {p.side === 'LONG' ? 'لانگ' : 'شورت'}
                        </span>
                      </td>
                      <td className="mono">{fmtPrice(p.entryPrice)}</td>
                      <td className="mono">{fmtPrice(p.markPrice)}</td>
                      <td className="mono num">{fmtNum(p.qty, 0)}</td>
                      <td className="mono">{fmtUsd(p.margin)}</td>
                      <td className="mono" style={{ color: pnlColor(p.unrealizedPnL) }}>
                        {fmtUsd(p.unrealizedPnL)} <small>({fmtPct(p.profitRate)})</small>
                      </td>
                      <td style={{ textAlign: 'left' }}>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            closePos(p)
                          }}
                          disabled={closing === p.symbol + p.side}
                        >
                          <i className={`ph ${closing === p.symbol + p.side ? 'ph-circle-notch spin' : 'ph-x'}`} aria-hidden /> <span>بستن</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* recent activity */}
        <aside className="side-panel">
          <div className="card panel-card">
            <div className="panel-title">
              <span>آخرین فعالیت‌ها</span>
              <i className="ph-fill ph-pulse" aria-hidden />
            </div>
            {logs.length === 0 ? (
              <div className="empty-state" style={{ padding: 16 }}>
                <i className="ph ph-scroll" aria-hidden />
                فعالیتی ثبت نشده
              </div>
            ) : (
              logs.slice(0, 7).map((l, i) => {
                const type = l.status === 'ERROR' ? 'danger' : l.status === 'WARNING' ? 'warning' : 'success'
                return (
                  <div className="activity-item" key={l.id ?? i}>
                    <div className="activity-icon" style={{ background: `var(--${type}-soft)`, color: `var(--${type})` }}>
                      <i
                        className={`ph ${l.status === 'ERROR' ? 'ph-x-circle' : l.status === 'WARNING' ? 'ph-warning' : 'ph-check-circle'}`}
                        aria-hidden
                      />
                    </div>
                    <div className="activity-content">
                      <div className="activity-text">
                        {l.symbol ? <b>{l.symbol} — </b> : null}
                        {l.message}
                      </div>
                      <div className="activity-time">{fmtAgo(l.created_at)}</div>
                    </div>
                  </div>
                )
              })
            )}
          </div>

          <div className="card panel-card">
            <div className="panel-title">
              <span>آخرین چرخه</span>
              <i className="ph-fill ph-robot" aria-hidden />
            </div>
            {lastCycle ? (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                  <span className="badge badge-info">{lastCycle.symbol ?? '—'}</span>
                  <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                    {lastCycle.source === 'cron' ? 'کرون' : 'دستی'}
                  </span>
                  <span className="badge" style={{ background: 'var(--bg-hover)', color: 'var(--text-muted)' }}>
                    <i className="ph ph-clock" aria-hidden /> <span className="num">{(lastCycle.durationMs / 1000).toFixed(1)}s</span>
                  </span>
                </div>
                <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  {lastCycle.steps.length > 0 ? lastCycle.steps[lastCycle.steps.length - 1].message : '—'}
                </p>
                <div className="activity-time">{fmtDateTime(lastCycle.finishedAt)}</div>
              </>
            ) : (
              <div className="empty-state" style={{ padding: 16 }}>
                <i className="ph ph-robot" aria-hidden />
                هنوز چرخه‌ای اجرا نشده
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* closed history */}
      <section className="card table-card">
        <div className="table-header">
          <span style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <i className="ph-fill ph-clock-counter-clockwise" style={{ color: 'var(--accent)' }} aria-hidden /> تاریخچه پوزیشن‌های بسته
            {stats ? <span className="badge badge-success">برد {stats.winning}</span> : null}
            {stats ? <span className="badge badge-danger">باخت {stats.losing}</span> : null}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadAll} disabled={busy === 'all'}>
            <i className="ph ph-arrows-clockwise" aria-hidden /> <span>بروزرسانی</span>
          </button>
        </div>
        {history && history.history.length > 0 ? (
          <div className="table-container">
            <table className="tb-table">
              <thead>
                <tr>
                  <th>زمان بستن</th>
                  <th>نماد</th>
                  <th>جهت</th>
                  <th>قیمت بستن</th>
                  <th>سود/زیان</th>
                  <th>نرخ</th>
                  <th>علت</th>
                </tr>
              </thead>
              <tbody>
                {history.history.slice(0, 15).map((h) => (
                  <tr key={String(h.id) + String(h.closeTime)}>
                    <td style={{ fontSize: 12 }}>{fmtDateTime(h.closeTime)}</td>
                    <td style={{ fontWeight: 600 }}>{shortSymbol(h.symbol)}</td>
                    <td>
                      <span className={h.side === 'LONG' ? 'long' : 'short'} style={{ fontWeight: 700 }}>
                        {h.side === 'LONG' ? 'لانگ' : 'شورت'}
                      </span>
                    </td>
                    <td className="mono">{fmtPrice(h.closePrice)}</td>
                    <td className="mono" style={{ color: pnlColor(h.realizedPnl) }}>
                      {fmtUsd(h.realizedPnl)}
                    </td>
                    <td className="mono" style={{ color: pnlColor(h.realizedPnl) }}>
                      {fmtPct(h.realizedPnlRate)}
                    </td>
                    <td>
                      {h.closeReason ? (
                        <span className={`badge ${h.closeReason === 'TP' ? 'badge-success' : h.closeReason === 'SL' ? 'badge-danger' : 'badge-info'}`} style={{ fontSize: 10 }}>
                          {h.closeReason === 'TP' ? 'حد سود' : h.closeReason === 'SL' ? 'حد ضرر' : 'دستی'}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <i className="ph ph-clock-counter-clockwise" aria-hidden />
            تاریخچه‌ای موجود نیست
          </div>
        )}
      </section>
    </div>
  )
}
