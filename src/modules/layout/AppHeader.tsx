'use client'

/**
 * App header — page title + theme toggle + notifications + primary action.
 * NOTE: no Start/Stop buttons by design (instruction §10.1) — execution
 * is either Cron (cloud) or the single «یک چرخه» button.
 */
import { useState } from 'react'
import { useToast } from '@/modules/common/toast'

interface HeaderProps {
  title: string
  subtitle: string
  onRunCycle?: () => void
  running?: boolean
  onOpenMobileNav: () => void
}

export function AppHeader({ title, subtitle, onRunCycle, running, onOpenMobileNav }: HeaderProps) {
  const [dark, setDark] = useState<boolean | null>(null)
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

  return (
    <header className="top-header">
      <div className="header-right">
        <button type="button" className="icon-btn mobile-toggle" onClick={onOpenMobileNav} data-tooltip="منو" aria-label="باز کردن منو">
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
        <span className="demo-pill" data-tooltip="اجرای خودکار: کرون ابر — هر ۵ دقیقه">
          <i className="ph-fill ph-cloud-arrow-up" aria-hidden />
          <span className="num">*/5</span>
        </span>
        {onRunCycle ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRunCycle}
            disabled={running}
          >
            <i className={`ph ${running ? 'ph-circle-notch spin' : 'ph-play'}`} aria-hidden />
            <span>{running ? 'در حال اجرا…' : 'یک چرخه'}</span>
          </button>
        ) : null}
      </div>
    </header>
  )
}
