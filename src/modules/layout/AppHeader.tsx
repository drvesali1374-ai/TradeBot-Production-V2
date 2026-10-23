'use client'

/**
 * App header — page title + theme toggle + user profile chip (item 13).
 * Sticky on every view (mission §11).
 *
 * item 13 changes:
 *  - the user profile (avatar + name + logout) moved here from the sidebar
 *    footer and sits in the LEFTMOST slot of the header bar (RTL: last
 *    child of .header-left), where «یک چرخه» used to be.
 *  - the «یک چرخه» button was REMOVED (it lives in «چرخه و رویدادها»).
 *  - the cron schedule pill ("5-minute cloud cron") was REMOVED.
 */
import { useEffect, useRef, useState } from 'react'
import { useToast } from '@/modules/common/toast'

interface HeaderProps {
  title: string
  subtitle: string
  username: string | null
  onLogout: () => void
  onOpenMobileNav: () => void
}

export function AppHeader({ title, subtitle, username, onLogout, onOpenMobileNav }: HeaderProps) {
  const [dark, setDark] = useState<boolean | null>(null)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userRef = useRef<HTMLDivElement | null>(null)
  const { show } = useToast()

  const isDark = dark ?? (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'dark')

  const toggleTheme = () => {
    const next = isDark ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('tb-theme', next)
    } catch {
      /* ignore */
    }
    setDark(next === 'dark')
    show('تم', next === 'dark' ? 'حالت تاریک فعال شد' : 'حالت روشن فعال شد', 'info')
  }

  // close the user menu on outside click / Escape
  useEffect(() => {
    if (!userMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (userRef.current && !userRef.current.contains(e.target as Node)) setUserMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [userMenuOpen])

  return (
    <header className="top-header">
      <div className="header-right">
        <button type="button" className="icon-btn mobile-toggle" onClick={onOpenMobileNav} data-tooltip="منو" aria-label="باز کردن منو" aria-expanded="false">
          <i className="ph ph-list" aria-hidden />
        </button>
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="header-left">
        <button
          type="button"
          className="icon-btn"
          onClick={toggleTheme}
          data-tooltip="تغییر تم"
          aria-label="تغییر تم"
        >
          <i className={isDark ? 'ph ph-sun' : 'ph ph-moon'} aria-hidden />
        </button>

        {/* item 13 — user profile chip (leftmost slot of the header) */}
        <div className="header-user" ref={userRef}>
          <button
            type="button"
            className="user-chip"
            onClick={() => setUserMenuOpen((v) => !v)}
            aria-expanded={userMenuOpen}
            aria-haspopup="menu"
            aria-label={`حساب کاربری ${username ?? 'کاربر'}`}
            data-tooltip={username ?? undefined}
          >
            <span className="user-avatar">{(username ?? '؟').slice(0, 1).toUpperCase()}</span>
            <span className="user-chip-name">{username ?? 'کاربر'}</span>
            <i className="ph ph-caret-down" aria-hidden />
          </button>
          {userMenuOpen ? (
            <div className="user-menu" role="menu" aria-label="منوی کاربر">
              <div className="user-menu-head">
                <div className="user-name">{username ?? 'کاربر'}</div>
                <div className="user-role">
                  <span className="dot" /> مدیر ربات
                </div>
              </div>
              <button
                type="button"
                className="user-menu-item danger"
                role="menuitem"
                onClick={() => {
                  setUserMenuOpen(false)
                  onLogout()
                }}
              >
                <i className="ph ph-sign-out" aria-hidden /> <span>خروج از حساب</span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
