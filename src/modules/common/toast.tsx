'use client'

/**
 * Toast system — mirrors the theme's toast component.
 */
import { createContext, useCallback, useContext, useState } from 'react'

export type ToastType = 'success' | 'warning' | 'danger' | 'info'

interface ToastItem {
  id: number
  title: string
  msg?: string
  type: ToastType
}

interface ToastApi {
  show: (title: string, msg?: string, type?: ToastType) => void
}

const ToastCtx = createContext<ToastApi>({ show: () => {} })

export function useToast(): ToastApi {
  return useContext(ToastCtx)
}

const ICONS: Record<ToastType, string> = {
  success: 'ph-fill ph-check-circle',
  warning: 'ph-fill ph-warning',
  danger: 'ph-fill ph-x-circle',
  info: 'ph-fill ph-info',
}
const COLORS: Record<ToastType, { bg: string; color: string }> = {
  success: { bg: 'var(--success-soft)', color: 'var(--success)' },
  warning: { bg: 'var(--warning-soft)', color: 'var(--warning)' },
  danger: { bg: 'var(--danger-soft)', color: 'var(--danger)' },
  info: { bg: 'var(--accent-soft)', color: 'var(--accent)' },
}

let nextId = 1

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const remove = useCallback((id: number) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, hiding: true } as ToastItem & { hiding?: boolean } : t)))
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 300)
  }, [])

  const show = useCallback(
    (title: string, msg?: string, type: ToastType = 'info') => {
      const id = nextId++
      setToasts((list) => [...list.slice(-4), { id, title, msg, type }])
      setTimeout(() => remove(id), 3800)
    },
    [remove]
  )

  return (
    <ToastCtx.Provider value={{ show }}>
      {children}
      <div className="toast-container">
        {toasts.map((t) => {
          const c = COLORS[t.type]
          const hiding = (t as ToastItem & { hiding?: boolean }).hiding
          return (
            <div key={t.id} className={`toast${hiding ? ' hiding' : ''}`} role="status">
              <div className="toast-icon" style={{ background: c.bg, color: c.color }}>
                <i className={ICONS[t.type]} aria-hidden />
              </div>
              <div className="toast-body">
                <div className="toast-title">{t.title}</div>
                {t.msg ? <div className="toast-msg">{t.msg}</div> : null}
              </div>
            </div>
          )
        })}
      </div>
    </ToastCtx.Provider>
  )
}
