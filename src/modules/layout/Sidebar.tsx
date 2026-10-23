'use client'

/**
 * App sidebar — RTL fixed nav + view switching + mobile drawer.
 *
 * item 6 — COLLAPSIBLE on desktop (≥1025px): a floating round handle on the
 * sidebar's inner edge toggles an icon-only rail (76px). The collapsed
 * state persists in localStorage ('tb-sidebar-collapsed') and animates the
 * main content margin (CSS var --sidebar-width via body.sidebar-collapsed).
 * item 13 — the user profile/footer was REMOVED (moved to the app header).
 * item 14 — the per-symbol stats table was REMOVED (moved into the main
 * dashboard next to «موجودی و ریسک»).
 * The drawer (≤1024px) is unchanged: off-canvas, closes via navigation,
 * outside click (backdrop) or Escape (mission §12).
 */
import { useEffect, useState } from 'react'

export type ViewId = 'automation' | 'chart' | 'settings'

interface NavItem {
  id: ViewId
  label: string
  icon: string
  description: string
}

const NAV: NavItem[] = [
  { id: 'automation', label: 'اتوماسیون', icon: 'ph-fill ph-robot', description: 'پنل کنترل چرخه‌های معاملاتی' },
  { id: 'chart', label: 'چارت حرفه‌ای', icon: 'ph-fill ph-candlestick-chart', description: 'نمودار تعاملی با ابزار رسم' },
  { id: 'settings', label: 'تنظیمات', icon: 'ph-fill ph-gear-six', description: 'استراتژی، صرافی و اعلان‌ها' },
]

const SIDEBAR_COLLAPSED_KEY = 'tb-sidebar-collapsed'

interface SidebarProps {
  active: ViewId
  onNavigate: (v: ViewId) => void
  mobileOpen: boolean
  onCloseMobile: () => void
}

export function Sidebar({ active, onNavigate, mobileOpen, onCloseMobile }: SidebarProps) {
  // item 6 — persisted collapse (desktop rail), read lazily ONCE. This
  // component only mounts client-side AFTER auth resolves (the shell renders
  // a spinner while 'checking'), so the localStorage read can never cause a
  // hydration mismatch. The body class drives the sidebar width AND the
  // main-content margin (CSS var --sidebar-width).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    document.body.classList.toggle('sidebar-collapsed', collapsed)
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseMobile()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCloseMobile])

  // Lock body scroll while the drawer is open so the backdrop does not
  // fight the page behind it (mission §12 — smooth, no stuck layers).
  useEffect(() => {
    document.body.classList.toggle('nav-drawer-open', mobileOpen)
    return () => {
      document.body.classList.toggle('nav-drawer-open', false)
    }
  }, [mobileOpen])

  const toggleCollapsed = () => setCollapsed((v) => !v)

  return (
    <>
      <div
        className={`sidebar-backdrop${mobileOpen ? ' active' : ''}`}
        onClick={onCloseMobile}
        aria-hidden
      />
      <aside
        className={`sidebar${mobileOpen ? ' mobile-open' : ''}`}
        aria-label="ناوبری اصلی"
      >
        {/* item 6 — collapse handle (hidden ≤1024px via CSS; the mobile
            sidebar is a drawer that always shows full labels) */}
        <button
          type="button"
          className="sidebar-collapse-handle"
          onClick={toggleCollapsed}
          title={collapsed ? 'باز کردن نوار کناری' : 'بستن نوار کناری'}
          aria-label={collapsed ? 'باز کردن نوار کناری' : 'بستن نوار کناری'}
          aria-expanded={!collapsed}
        >
          <i className={`ph-bold ph-caret-${collapsed ? 'left' : 'right'}`} aria-hidden />
        </button>

        <div className="logo">
          <div className="logo-icon">
            <i className="ph-fill ph-robot" aria-hidden />
          </div>
          <div>
            <div className="logo-text">تریدبات</div>
          </div>
        </div>

        <nav className="nav-menu">
          <div className="nav-section-label">اصلی</div>
          {NAV.map((item) => (
            <div className="nav-item" key={item.id}>
              <button
                type="button"
                className={`nav-link${active === item.id ? ' active' : ''}`}
                onClick={() => {
                  onNavigate(item.id)
                  onCloseMobile()
                }}
                aria-current={active === item.id ? 'page' : undefined}
                title={collapsed ? item.label : item.description}
              >
                <i className={item.icon} aria-hidden />
                <span>{item.label}</span>
              </button>
            </div>
          ))}

          <div className="nav-section-label">سیستم</div>
          <div className="nav-item">
            <div
              className="nav-link"
              style={{ cursor: 'default', opacity: 0.75 }}
              title="زمان‌بندی ابر کلودفلر — هر ۵ دقیقه"
            >
              <i className="ph ph-cloud-check" aria-hidden />
              <span>کرون ابری</span>
              <span className="nav-badge" style={{ background: 'var(--success)' }} title="فعال">
                <i className="ph-fill ph-check" style={{ fontSize: 10 }} aria-hidden />
              </span>
            </div>
          </div>
        </nav>
      </aside>
    </>
  )
}
