'use client'

/**
 * TradeBot v2 — single-page application shell.
 * Views: automation / chart / settings (+ login gate).
 * The dashboard page was removed from the final interface (mission §7)
 * — automation IS the main view after login.
 * Execution model (instruction §10.1): NO browser scheduler — automation
 * runs via cloud cron; the ONLY manual trigger is «یک چرخه» (automation
 * view only, mission §7.5).
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

const VIEW_META: Record<ViewId, { title: string; subtitle: string }> = {
  automation: { title: 'اتوماسیون', subtitle: 'پنل کنترل و مشاهده چرخه‌های معاملاتی' },
  chart: { title: 'چارت حرفه‌ای', subtitle: 'نمودار تعاملی، سیگنال‌ها و ابزار رسم' },
  settings: { title: 'تنظیمات', subtitle: 'استراتژی، اتصال صرافی و اعلان‌ها' },
}

function Shell() {
  const [authState, setAuthState] = useState<'checking' | 'login' | 'ready'>('checking')
  const [username, setUsername] = useState<string | null>(null)
  const [view, setView] = useState<ViewId>('automation')
  const [mobileNav, setMobileNav] = useState(false)
  const [running, setRunning] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const [chartSymbol, setChartSymbol] = useState('BTC')
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

  const bumpRefresh = useCallback(() => setRefreshKey((k) => k + 1), [])

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

  return (
    <>
      <Sidebar
        active={view}
        onNavigate={setView}
        username={username}
        onLogout={handleLogout}
        mobileOpen={mobileNav}
        onCloseMobile={() => setMobileNav(false)}
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
            <AutomationView refreshKey={refreshKey} onRefreshAll={bumpRefresh} onGoChart={(s) => { setChartSymbol(s); setView('chart') }} onRunCycle={runCycle} running={running} />
          ) : null}
          {view === 'chart' ? <ChartView initialSymbol={chartSymbol} onSymbolChange={setChartSymbol} /> : null}
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
