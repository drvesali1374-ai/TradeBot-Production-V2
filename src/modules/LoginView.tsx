'use client'

/**
 * Login view — session auth gate.
 */
import { useState } from 'react'
import { apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'

export function LoginView({ onLoggedIn }: { onLoggedIn: (username: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { show } = useToast()

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await apiPost('/api/auth/login', { username, password })
      show('ورود موفق', 'خوش آمدید!', 'success')
      onLoggedIn(username)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ورود ناموفق')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="modal-header" style={{ marginBottom: 22 }}>
          <div className="modal-title-wrap">
            <div className="modal-icon">
              <i className="ph-fill ph-robot" aria-hidden />
            </div>
            <div>
              <h1 className="modal-title">تریدبات</h1>
              <p className="modal-subtitle">پلتفرم معاملات خودکار — نسخه ۲</p>
            </div>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="form-group">
            <label className="form-label" htmlFor="login-username">
              نام کاربری
            </label>
            <input
              id="login-username"
              className="form-input"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="نام کاربری"
              required
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="login-password">
              رمز عبور
            </label>
            <input
              id="login-password"
              className="form-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>

          {error ? (
            <div
              className="badge badge-danger"
              style={{ width: '100%', justifyContent: 'center', padding: '10px', marginBottom: 14, borderRadius: 12 }}
              role="alert"
            >
              <i className="ph-fill ph-warning-circle" aria-hidden /> {error}
            </div>
          ) : null}

          <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
            <i className={`ph ${busy ? 'ph-circle-notch spin' : 'ph-sign-in'}`} aria-hidden />
            <span>ورود به پنل</span>
          </button>
        </form>

        <div className="login-demo-hint">
          <b>محیط آزمایشی:</b> نخستین ورود، نام کاربری و رمز شما را به‌عنوان اعتبارنامه ثبت می‌کند (مثلاً <span className="mono">admin / admin123</span>).
          در استقرار واقعی، متغیرهای <span className="mono">AUTH_USERNAME</span> و <span className="mono">AUTH_PASSWORD</span> را تنظیم کنید.
        </div>
      </div>
    </div>
  )
}
