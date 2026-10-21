'use client'

/**
 * TradeBot v2 — single-page application shell.
 * Views: automation / chart / settings (+ login gate).
 * The dashboard page was removed from the final interface (mission §7)
 * — automation IS the main view after login.
 * Execution model (instruction §10.1): NO browser scheduler — automation
 * runs via cloud cron; the ONLY manual trigger is «یک چرخه» (automation
 * view only, mission §7.5).
 *
 * Signal → chart navigation contract (mission §7.1/§7.3):
 *  - `chartFocus` carries the REAL candle time of a signal (candleOpenTime
 *    in EPOCH MILLISECONDS — never Date.now()/live price).
 *  - goToSignal sets symbol+interval+focus, switches to the chart view and
 *    writes the minimal URL `?chart=<SYM>&interval=<IV>&focus=<ms>[&side=…]`
 *    so a REFRESH restores the same focus (parse on mount).
 *  - a MANUAL symbol/interval change in the chart toolbar drops the focus
 *    (state cleared + URL params stripped).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader } from '@/modules/layout/AppHeader'
import { Sidebar, type ViewId } from '@/modules/layout/Sidebar'
import { LoginView } from '@/modules/LoginView'
import { ToastProvider } from '@/modules/common/toast'
import { AutomationView } from '@/modules/automation/AutomationView'
import { ChartView } from '@/modules/chart/ChartView'
import { SettingsView } from '@/modules/settings/SettingsView'
import { apiGet, apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import type { SymbolStatsPayload } from '@/modules/automation/SymbolStatsTable'
import { INTERVALS, type ChartFocusPayload } from '@/modules/chart/types'
import { buildChartFocusSearch, parseChartFocusSearch, stripChartFocusKeys } from '@/modules/chart/focusUrl'
import type { Signal } from '@/core/types'

const VIEW_META: Record<ViewId, { title: string; subtitle: string }> = {
  automation: { title: 'اتوماسیون', subtitle: 'پنل کنترل و مشاهده چرخه‌های معاملاتی' },
  chart: { title: 'چارت حرفه‌ای', subtitle: 'نمودار تعاملی، سیگنال‌ها و ابزار رسم' },
  settings: { title: 'تنظیمات', subtitle: 'استراتژی، اتصال صرافی و اعلان‌ها' },
}

/**
 * Page-level chart focus (mission §7.1).
 * UNITS: signalTime = the signal's candleOpenTime in EPOCH MILLISECONDS.
 */
interface ChartFocusState {
  symbol: string
  interval: string
  signalTime: number
  side?: 'Long' | 'Short'
  price?: number
  tp?: number
  sl?: number
  signalId?: string
}

function Shell() {
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking')
  const [username, setUsername] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>('automation')
  const [mobileNav, setMobileNav] = useState(false)
  const [running, setRunning] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [chartSymbol, setChartSymbol] = useState('BTC')
  const [chartInterval, setChartInterval] = useState('1h')
  // §7 — signal-candle focus for the professional chart (null = none)
  const [chartFocus, setChartFocus] = useState<ChartFocusState | null>(null)
  // §8-UI — per-symbol closed-trade stats: fetched once per mount and
  // re-fetched on EVERY refreshKey bump (covers «after each cycle run» —
  // runCycle bumps the key via bumpRefresh). Shared by Sidebar + AutomationView.
  const [symbolStats, setSymbolStats] = useState<SymbolStatsPayload | null>(null)
  const { show } = useToast()
  const toastShown = useRef(false)

  useEffect(() => {
    let alive = true
    apiGet<{ authenticated: boolean; username?: string }>('/api/auth/verify')
      .then((r) => {
        if (!alive) return
        if (r.authenticated) {
          setUsername(r.username ?? null)
          setAuthState('ready')
        } else {
          setAuthState('login')
        }
      })
      .catch(() => alive && setAuthState('login'))
    return () => {
      alive = false
    }
  }, [])

  // §7.3 — refresh-restore: parse ?chart&interval&focus[&side] back into the
  // chart state so the professional chart re-opens AT the signal candle.
  // (Runs before login resolves too — the focus simply waits in state.)
  useEffect(() => {
    const f = parseChartFocusSearch(window.location.search)
    if (!f) return
    setChartSymbol(f.symbol)
    setChartInterval(f.interval)
    setChartFocus({ ...f })
    setView('chart')
  }, [])

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  // §8-UI stats fetch — read-only; NO_CREDENTIALS comes back as
  // success:false (HTTP 200) so the UI shows «خطای دریافت آمار» without
  // throwing; a network failure also degrades to success:false. Retry
  // happens on the next refreshKey bump — never fake zeros (mission §8.3).
  useEffect(() => {
    if (authState !== 'ready') return
    let alive = true
    apiGet<SymbolStatsPayload>('/api/diagnostics/symbol-stats')
      .then((r) => {
        if (alive) setSymbolStats(r)
      })
      .catch(() => {
        if (alive) setSymbolStats({ success: false, stats: [], error: 'خطای شبکه' })
      })
    return () => {
      alive = false
    }
  }, [authState, refreshKey])

  const handleLoggedIn = useCallback((name: string) => {
    setUsername(name)
    setAuthState('ready')
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await apiPost('/api/auth/logout')
    } catch {
      /* ignore */
    }
    setUsername(null)
    setAuthState('login')
    toastShown.current = false
  }, [])

  /* ——— §7.1 chart-focus navigation ——— */

  /** Drop the focus: clear state AND strip the focus params from the URL. */
  const clearChartFocus = useCallback(() => {
    setChartFocus(null)
    try {
      const rest = stripChartFocusKeys(window.location.search)
      window.history.replaceState(null, '', rest ? `${window.location.pathname}${rest}` : window.location.pathname)
    } catch {
      /* history unavailable — state is still cleared */
    }
  }, [])

  /**
   * Navigate to the professional chart AT a signal's real candle.
   * signalTime = candleOpenTime in epoch MILLISECONDS (mission §7 — never
   * Date.now(), never the live price). Writes the minimal restorable URL.
   */
  const goToSignal = useCallback(
    (signal: Signal, interval: string) => {
      const symbol = String(signal.symbol).replace(/(-SWAP)?-?USDT$/i, '').toUpperCase()
      const iv = (INTERVALS as readonly string[]).includes(interval) ? interval : '1h'
      const signalTime = Number(signal.candleOpenTime)
      if (!Number.isFinite(signalTime) || signalTime <= 0) return // no candle time → no focus
      setChartSymbol(symbol)
      setChartInterval(iv)
      setChartFocus({
        symbol,
        interval: iv,
        signalTime,
        ...(signal.side === 'Long' || signal.side === 'Short' ? { side: signal.side } : {}),
        ...(Number.isFinite(signal.price) ? { price: Number(signal.price) } : {}),
        ...(Number.isFinite(signal.tp) ? { tp: Number(signal.tp) } : {}),
        ...(Number.isFinite(signal.sl) ? { sl: Number(signal.sl) } : {}),
        signalId: signal.id,
      })
      setView('chart')
      try {
        window.history.replaceState(
          null,
          '',
          buildChartFocusSearch({
            symbol,
            interval: iv,
            signalTime,
            ...(signal.side === 'Long' || signal.side === 'Short' ? { side: signal.side } : {}),
          }),
        )
      } catch {
        /* history unavailable — navigation still works in-memory */
      }
    },
    [],
  )

  // manual toolbar changes drop the focus (mission §7.1: «اندکی که کاربر
  // خودش نماد/بازه را عوض کند، فوکوس باید بیفتد») — ChartView only fires
  // these on real user changes, not on goToSignal-driven prop updates.
  const handleChartSymbol = useCallback(
    (s: string) => {
      setChartSymbol(s)
      clearChartFocus()
    },
    [clearChartFocus],
  )

  const handleChartInterval = useCallback(
    (i: string) => {
      setChartInterval(i)
      clearChartFocus()
    },
    [clearChartFocus],
  )

  const runCycle = useCallback(async () => {
    if (running) return
    setRunning(true)
    try {
      const res = await apiPost<{ success: boolean; result?: { action: string; symbol: string | null; durationMs: number; error?: string } }>(
        '/api/automation/run-cycle',
        {}
      )
      if (res.success && res.result) {
        const r = res.result
        const ok = r.action.startsWith('POSITION_OPENED')
        show(
          r.action === 'NO_READY_SYMBOL'
            ? 'نماد آماده نیست'
            : ok
              ? 'پوزیشن باز شد'
              : 'چرخه اجرا شد',
          `${r.symbol ?? '—'} · ${r.durationMs}ms${r.error ? ` · ${r.error}` : ''}`,
          ok ? 'success' : r.action === 'ERROR' ? 'danger' : 'info'
        )
      }
      bumpRefresh()
    } catch (e) {
      show('اجرای چرخه ناموفق', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setRunning(false)
    }
  }, [running, show, bumpRefresh])

  if (authState === 'checking') {
    return (
      <div className="login-page">
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <i className="ph ph-circle-notch spin" style={{ fontSize: 34 }} aria-hidden />
        </div>
      </div>
    )
  }

  if (authState === 'login') {
    return <LoginView onLoggedIn={handleLoggedIn} />
  }

  const meta = VIEW_META[view]
  const showRun = view === 'automation'

  const focusPayload: ChartFocusPayload | null = chartFocus
    ? {
        signalTime: chartFocus.signalTime,
        ...(chartFocus.side ? { side: chartFocus.side } : {}),
        ...(chartFocus.price != null ? { price: chartFocus.price } : {}),
        ...(chartFocus.tp != null ? { tp: chartFocus.tp } : {}),
        ...(chartFocus.sl != null ? { sl: chartFocus.sl } : {}),
        ...(chartFocus.signalId != null ? { signalId: chartFocus.signalId } : {}),
      }
    : null

  return (
    <>
      <Sidebar
        active={view}
        onNavigate={setView}
        username={username}
        onLogout={handleLogout}
        mobileOpen={mobileNav}
        onCloseMobile={() => setMobileNav(false)}
        symbolStats={symbolStats}
      />
      <main className="main-content">
        <AppHeader
          title={meta.title}
          subtitle={meta.subtitle}
          onRunCycle={showRun ? runCycle : undefined}
          running={running}
          onOpenMobileNav={() => setMobileNav(true)}
        />
        <div key={`${view}-${refreshKey}`} className="view-enter" style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          {view === 'automation' ? (
            <AutomationView refreshKey={refreshKey} onRefreshAll={bumpRefresh} onGoChart={(s) => { setChartSymbol(s); clearChartFocus(); setView('chart') }} onGoSignal={goToSignal} onRunCycle={runCycle} running={running} symbolStats={symbolStats} />
          ) : null}
          {view === 'chart' ? (
            <ChartView
              initialSymbol={chartSymbol}
              initialInterval={chartInterval}
              focus={focusPayload}
              onSymbolChange={handleChartSymbol}
              onIntervalChange={handleChartInterval}
              onFocusDrop={clearChartFocus}
            />
          ) : null}
          {view === 'settings' ? <SettingsView onSaved={bumpRefresh} /> : null}
        </div>
        <footer className="app-footer">
          <span>
            <i className="ph-fill ph-robot" style={{ color: 'var(--accent)' }} aria-hidden /> تریدبات نسخه ۲ — استراتژی Fake
            Breakout · صرافی توبیت
          </span>
          <span>
            <span className="badge badge-info" style={{ fontSize: 10 }}>
              <span className="badge-dot-sm" /> زمان‌بندی چرخه: کرون ابر (*/۵ دقیقه)
            </span>
          </span>
        </footer>
      </main>
    </>
  )
}

export default function Home() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
