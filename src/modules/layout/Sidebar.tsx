'use client'

/**
 * App sidebar — RTL fixed nav, view switching, mobile drawer.
 * Active views only (mission §7): automation / chart / settings.
 * The drawer sits ABOVE its backdrop (z-index 110 vs 100) and closes
 * via navigation, outside click (backdrop) or Escape (mission §12).
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

interface SidebarProps {
  active: ViewId
  onNavigate: (v: ViewId) => void
  username: string | null
  onLogout: () => void
  mobileOpen: boolean
  onCloseMobile: () => void
}

export function Sidebar({ active, onNavigate, username, onLogout, mobileOpen, onCloseMobile }: SidebarProps) {
  const [profileOpen, setProfileOpen] = useState(false)

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
        aria-hidden={undefined}
      >
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

        <div className="sidebar-footer">
          <div className="user-card" onClick={() => setProfileOpen((v) => !v)}>
            <div className="user-avatar">{(username ?? '؟').slice(0, 1)}</div>
            <div className="user-info">
              <div className="user-name">{username ?? 'کاربر'}</div>
              <div className="user-plan">
                <span className="dot" /> مدیر ربات
              </div>
            </div>
            <i className="ph ph-sign-out" style={{ color: 'var(--danger)' }} aria-hidden />
          </div>
          {profileOpen ? (
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
              onClick={onLogout}
            >
              <i className="ph ph-sign-out" aria-hidden /> <span>خروج از حساب</span>
            </button>
          ) : null}
        </div>
      </aside>
    </>
  )
}
