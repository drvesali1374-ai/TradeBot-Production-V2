'use client'

/**
 * Settings view — 3 tabs:
 *  1. اتصال و اعلان‌ها (exchange keys — REDACTED echo, bale, security)
 *  2. استراتژی (the 7 groups from the reference settings modal)
 *  3. امنیت (credential update)
 * Keys are stored server-side only; blank key inputs keep current values.
 */
import { useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import type { AutomationSettings, AccountSettings } from '@/core/settings'

type RedactedAccount = AccountSettings & { hasApiKey: boolean; hasSecretKey: boolean; hasBale: boolean }

/* ---------------- small field components ---------------- */

function NumField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  hint,
  placeholder,
}: {
  id: string
  label: string
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  hint?: string
  placeholder?: string
}) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="form-input"
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value
          onChange(raw === '' ? null : Number(raw))
        }}
      />
      {hint ? <div className="form-hint">{hint}</div> : null}
    </div>
  )
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="form-section">
      <div className="form-section-title">
        <i className={icon} aria-hidden /> {title}
      </div>
      <div className="form-row">{children}</div>
    </div>
  )
}

/* ---------------- main view ---------------- */

export function SettingsView({ onSaved }: { onSaved: () => void }) {
  const { show } = useToast()
  const [tab, setTab] = useState<'account' | 'strategy' | 'security'>('account')
  const [automation, setAutomation] = useState<AutomationSettings | null>(null)
  const [account, setAccount] = useState<RedactedAccount | null>(null)
  const [busy, setBusy] = useState(false)

  const [apiKey, setApiKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [baleToken, setBaleToken] = useState('')
  const [baleChatId, setBaleChatId] = useState('')

  const [curPassword, setCurPassword] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')

  useEffect(() => {
    apiGet<{ automation: AutomationSettings; account: RedactedAccount }>('/api/settings')
      .then((r) => {
        setAutomation(r.automation)
        setAccount(r.account)
        setBaleToken(r.account.baleToken)
        setBaleChatId(r.account.baleChatId)
      })
      .catch((e) => show('تنظیمات', e instanceof Error ? e.message : 'خطا', 'danger'))
  }, [show])

  const setA = useCallback(<K extends keyof AutomationSettings>(key: K, value: AutomationSettings[K]) => {
    setAutomation((a) => (a ? { ...a, [key]: value } : a))
  }, [])

  const saveStrategy = async () => {
    if (!automation) return
    setBusy(true)
    try {
      const r = await apiPost<{ automation: AutomationSettings }>('/api/settings', {
        group: 'automation',
        values: automation,
      })
      setAutomation(r.automation)
      show('تنظیمات استراتژی', 'با موفقیت ذخیره شد', 'success')
      onSaved()
    } catch (e) {
      show('ذخیره ناموفق', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setBusy(false)
    }
  }

  const saveAccount = async () => {
    setBusy(true)
    try {
      const values: Record<string, string> = { baleToken, baleChatId }
      if (apiKey.trim() && !apiKey.includes('••')) values.apiKey = apiKey.trim()
      if (secretKey.trim() && !secretKey.includes('••')) values.secretKey = secretKey.trim()
      const r = await apiPost<{ account: RedactedAccount }>('/api/settings', { group: 'account', values })
      setAccount(r.account)
      setApiKey('')
      setSecretKey('')
      show('تنظیمات اتصال', 'با موفقیت ذخیره شد', 'success')
      onSaved()
    } catch (e) {
      show('ذخیره ناموفق', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setBusy(false)
    }
  }

  const testBale = async () => {
    setBusy(true)
    try {
      const r = await apiPost<{ success: boolean; message: string }>('/api/settings/test-bale', {})
      show('تست بله', r.message, r.success ? 'success' : 'warning')
    } catch (e) {
      show('تست بله', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setBusy(false)
    }
  }

  const updateCreds = async () => {
    setBusy(true)
    try {
      await apiPost('/api/auth/update-credentials', {
        currentPassword: curPassword,
        newUsername,
        newPassword,
      })
      show('امنیت', 'اعتبارنامه‌ها به‌روزرسانی شد — سایر نشست‌ها باطل شدند', 'success')
      setCurPassword('')
      setNewPassword('')
    } catch (e) {
      show('به‌روزرسانی ناموفق', e instanceof Error ? e.message : 'خطا', 'danger')
    } finally {
      setBusy(false)
    }
  }

  const tabs = [
    { id: 'account' as const, label: 'اتصال و اعلان', icon: 'ph ph-plugs' },
    { id: 'strategy' as const, label: 'استراتژی', icon: 'ph ph-chart-line' },
    { id: 'security' as const, label: 'امنیت', icon: 'ph ph-shield-check' },
  ]

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div className="table-header">
        <div className="segmented-control">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`seg-tab${tab === t.id ? ' active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <i className={t.icon} aria-hidden /> {t.label}
            </button>
          ))}
        </div>
        {account ? (
          <span className={`badge ${account.hasApiKey && account.hasSecretKey ? 'badge-success' : 'badge-warning'}`}>
            <span className="badge-dot-sm" />
            {account.hasApiKey && account.hasSecretKey ? 'کلید API تنظیم شده — حالت زنده' : 'بدون کلید — حالت آزمایشی'}
          </span>
        ) : null}
      </div>

      {/* item 15 — NO inner scroll container: the settings content flows
          naturally and the PAGE is the single scrollbar (the old
          maxHeight+overflowY created a second scrollbar on small screens). */}
      <div style={{ padding: 22 }}>
        {/* ============== TAB 1: account ============== */}
        {tab === 'account' ? (
          <div style={{ maxWidth: 620 }}>
            <div className="form-section">
              <div className="form-section-title">
                <i className="ph ph-key" aria-hidden /> کلیدهای API صرافی توبیت
              </div>
              <p className="form-hint" style={{ marginBottom: 12 }}>
                کلیدها فقط در سمت سرور ذخیره می‌شوند و هرگز به مرورگر بازگردانده نمی‌شوند. برای حفظ مقدار فعلی، خالی بگذارید.
                {account?.hasApiKey ? ` (کلید فعلی: ${account.apiKey})` : ' (کلیدی تنظیم نشده — محیط آزمایشی فعال است)'}
              </p>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="set-api-key">
                    API Key
                  </label>
                  <input id="set-api-key" className="form-input" dir="ltr" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="کلید عمومی صرافی" autoComplete="off" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="set-secret-key">
                    Secret Key
                  </label>
                  <input id="set-secret-key" className="form-input" dir="ltr" type="password" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder="کلید محرمانه" autoComplete="off" />
                </div>
              </div>
              <div className="form-hint">Base URL: <span className="mono">https://api.toobit.com</span> (ثابت — قابل تغییر از سمت کلاینت نیست)</div>
            </div>

            <div className="form-section">
              <div className="form-section-title">
                <i className="ph ph-telegram-logo" aria-hidden /> اعلان‌های بله
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="set-bale-token">
                    توکن ربات بله
                  </label>
                  <input id="set-bale-token" className="form-input" dir="ltr" value={baleToken} onChange={(e) => setBaleToken(e.target.value)} placeholder="توکن از BotFather بله" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="set-bale-chat">
                    شناسه چت (Chat ID)
                  </label>
                  <input id="set-bale-chat" className="form-input" dir="ltr" value={baleChatId} onChange={(e) => setBaleChatId(e.target.value)} placeholder="مثلاً 123456789" />
                </div>
              </div>
              <button type="button" className="btn btn-outline btn-sm" onClick={testBale} disabled={busy}>
                <i className="ph ph-paper-plane-tilt" aria-hidden /> <span>ارسال پیام آزمایشی</span>
              </button>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={saveAccount} disabled={busy}>
                <i className={`ph ${busy ? 'ph-circle-notch spin' : 'ph-check'}`} aria-hidden /> <span>ذخیره تنظیمات اتصال</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* ============== TAB 2: strategy ============== */}
        {tab === 'strategy' && automation ? (
          <div style={{ maxWidth: 760 }}>
            <Section icon="ph ph-shield-warning" title="مدیریت ریسک">
              <NumField id="st-safe" label="دارایی امن ٪" value={automation.safeAssetPercent} onChange={(v) => setA('safeAssetPercent', v ?? 0)} min={0} max={100} step={1} hint="حداقل درصد کل دارایی که باید آزاد بماند" />
              <NumField id="st-maxmargin" label="سقف مارجین نماد ٪" value={automation.maxMarginPerSymbolPercent} onChange={(v) => setA('maxMarginPerSymbolPercent', v ?? 10)} min={1} max={100} step={1} hint="حداکثر درصد کل دارایی برای مارجین یک نماد" />
              <NumField id="st-expiry" label="انقضای سیگنال (ساعت)" value={automation.signalExpirationHours} onChange={(v) => setA('signalExpirationHours', v ?? 6)} min={1} max={48} step={1} hint="مدت اعتبار سیگنال پیش از انقضا" />
              <NumField id="st-minsame" label="حداقل کندل هم‌جهت" value={automation.minSameDirectionCandles} onChange={(v) => setA('minSameDirectionCandles', v ?? 0)} min={0} max={10} step={1} hint="بعد از سیگنال — صفر یعنی غیرفعال" />
              <NumField id="st-dist-l" label="فاصله قیمت بهتر ٪ — لانگ" value={automation.minPriceDistancePercentLong} onChange={(v) => setA('minPriceDistancePercentLong', v ?? 0.5)} min={0} max={50} step={0.1} hint="حداقل فاصله برای ورود دوم روی یک نماد" />
              <NumField id="st-dist-s" label="فاصله قیمت بهتر ٪ — شورت" value={automation.minPriceDistancePercentShort} onChange={(v) => setA('minPriceDistancePercentShort', v ?? 0.5)} min={0} max={50} step={0.1} />
            </Section>

            <Section icon="ph ph-cpu" title="اجرای معاملات">
              <NumField id="st-wait" label="زمان انتظار (دقیقه)" value={automation.tradeWaitTime} onChange={(v) => setA('tradeWaitTime', v ?? 60)} min={1} max={1440} step={1} hint="فاصله حداقلی بین چرخه‌های یک نماد" />
              <NumField id="st-errors" label="خطای مجاز" value={automation.allowedErrors} onChange={(v) => setA('allowedErrors', v ?? 3)} min={1} max={10} step={1} hint="پس از این تعداد خطای متوالی، نماد رد می‌شود" />
              <NumField id="st-cycles" label="تعداد چرخه در هر اجرا" value={automation.cyclesPerRun} onChange={(v) => setA('cyclesPerRun', v ?? 1)} min={1} max={10} step={1} />
              <NumField id="st-notify" label="تعداد نوتیف تاریخچه" value={automation.closedPositionsNotifyCount} onChange={(v) => setA('closedPositionsNotifyCount', v ?? 10)} min={1} max={50} step={1} />
              <NumField id="st-lev-l" label="اهرم — لانگ" value={automation.leverageLong} onChange={(v) => setA('leverageLong', v ?? 4)} min={1} max={125} step={1} />
              <NumField id="st-lev-s" label="اهرم — شورت" value={automation.leverageShort} onChange={(v) => setA('leverageShort', v ?? 4)} min={1} max={125} step={1} />
              <NumField id="st-em-l" label="نسبت مارجین ورودی ٪ — لانگ" value={automation.entryMarginPercentLong} onChange={(v) => setA('entryMarginPercentLong', v ?? 5)} min={0} max={100} step={0.5} hint="درصد کل دارایی برای مارجین هر ورودی جدید" />
              <NumField id="st-em-s" label="نسبت مارجین ورودی ٪ — شورت" value={automation.entryMarginPercentShort} onChange={(v) => setA('entryMarginPercentShort', v ?? 5)} min={0} max={100} step={0.5} />
            </Section>

            <Section icon="ph ph-chart-bar" title="بازار">
              <div className="form-group">
                <label className="form-label" htmlFor="st-interval">
                  تایم‌فریم
                </label>
                <select
                  id="st-interval"
                  className="form-input"
                  value={automation.interval}
                  onChange={(e) => setA('interval', e.target.value as AutomationSettings['interval'])}
                >
                  <option value="1h">۱ ساعته</option>
                  <option value="30m">۳۰ دقیقه</option>
                  <option value="15m">۱۵ دقیقه</option>
                  <option value="4h">۴ ساعته</option>
                  <option value="1d">۱ روزه</option>
                </select>
              </div>
              <NumField id="st-limit" label="تعداد کندل" value={automation.limit} onChange={(v) => setA('limit', v ?? 1000)} min={10} max={2000} step={1} hint="تعداد کندل دریافتی از صرافی" />
              <NumField id="st-lookback" label="دوره برگشت (LookBack)" value={automation.lookback} onChange={(v) => setA('lookback', v ?? 50)} min={10} max={200} step={1} />
              <NumField id="st-avgvol" label="دوره میانگین حجم" value={automation.avgVolPeriod} onChange={(v) => setA('avgVolPeriod', v ?? 50)} min={10} max={200} step={1} />
            </Section>

            <Section icon="ph ph-chart-line" title="اندیکاتورها">
              <div className="form-group">
                <label className="form-label" htmlFor="st-htf">
                  مبنای HTF Confirmation
                </label>
                <select
                  id="st-htf"
                  className="form-input"
                  value={automation.htfConfirmationSource}
                  onChange={(e) => setA('htfConfirmationSource', e.target.value as AutomationSettings['htfConfirmationSource'])}
                >
                  <option value="signalCandleClose">کلوز کندل سیگنال (پیش‌فرض)</option>
                  <option value="previousDayClose">کلوز روز قبل</option>
                </select>
                <div className="form-hint">کلوز کندل سیگنال با سطوح روز قبل مقایسه می‌شود</div>
              </div>
              <NumField id="st-rsi-p" label="دوره RSI" value={automation.rsiPeriod} onChange={(v) => setA('rsiPeriod', v ?? 14)} min={5} max={50} step={1} />
              <NumField id="st-atr-p" label="دوره ATR" value={automation.atrPeriod} onChange={(v) => setA('atrPeriod', v ?? 14)} min={5} max={50} step={1} />
              <NumField id="st-rsi-l" label="آستانه RSI — لانگ (اشباع فروش)" value={automation.rsiLongThreshold} onChange={(v) => setA('rsiLongThreshold', v ?? 30)} min={0} max={100} step={1} />
              <NumField id="st-rsi-s" label="آستانه RSI — شورت (اشباع خرید)" value={automation.rsiShortThreshold} onChange={(v) => setA('rsiShortThreshold', v ?? 70)} min={0} max={100} step={1} />
              <NumField id="st-vol-l" label="ضریب حجم — لانگ" value={automation.volMultLong} onChange={(v) => setA('volMultLong', v ?? 0.2)} min={0} max={5} step={0.05} />
              <NumField id="st-vol-s" label="ضریب حجم — شورت" value={automation.volMultShort} onChange={(v) => setA('volMultShort', v ?? 0.2)} min={0} max={5} step={0.05} />
            </Section>

            <Section icon="ph ph-target" title="اهداف TP/SL — لانگ">
              <NumField id="st-tpl" label="ضریب TP (×ATR)" value={automation.tpLongMult} onChange={(v) => setA('tpLongMult', v ?? 20)} min={1} max={100} step={1} />
              <NumField id="st-sll" label="ضریب SL (×ATR)" value={automation.slLongMult} onChange={(v) => setA('slLongMult', v ?? 6)} min={1} max={50} step={1} />
              <NumField id="st-ftpl" label="TP ثابت (٪)" value={automation.longFixedTp} onChange={(v) => setA('longFixedTp', v)} min={0.1} max={50} step={0.1} placeholder="خالی = مبتنی بر ATR" />
              <NumField id="st-fsll" label="SL ثابت (٪)" value={automation.longFixedSl} onChange={(v) => setA('longFixedSl', v)} min={0.1} max={50} step={0.1} placeholder="خالی = مبتنی بر ATR" />
            </Section>

            <Section icon="ph ph-target" title="اهداف TP/SL — شورت">
              <NumField id="st-tps" label="ضریب TP (×ATR)" value={automation.tpShortMult} onChange={(v) => setA('tpShortMult', v ?? 24)} min={1} max={100} step={1} />
              <NumField id="st-sls" label="ضریب SL (×ATR)" value={automation.slShortMult} onChange={(v) => setA('slShortMult', v ?? 4)} min={1} max={50} step={1} />
              <NumField id="st-ftps" label="TP ثابت (٪)" value={automation.shortFixedTp} onChange={(v) => setA('shortFixedTp', v)} min={0.1} max={50} step={0.1} placeholder="خالی = مبتنی بر ATR" />
              <NumField id="st-fsls" label="SL ثابت (٪)" value={automation.shortFixedSl} onChange={(v) => setA('shortFixedSl', v)} min={0.1} max={50} step={0.1} placeholder="مثلاً 6" />
            </Section>

            <div className="form-section">
              <div className="form-section-title">
                <i className="ph ph-lightning" aria-hidden /> Fake Breakout
              </div>
              <div className="toggle-row" style={{ marginBottom: 10 }}>
                <div className="toggle-row-left">
                  <i className="ph ph-funnel" aria-hidden />
                  <div>
                    <div className="toggle-label">فیلتر شکست معنادار (ATR)</div>
                    <div className="toggle-desc">شکست فقط با عبور حداقل ATR×ضریب معتبر است</div>
                  </div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={automation.enableMeaningfulBreakFilter} onChange={(e) => setA('enableMeaningfulBreakFilter', e.target.checked)} />
                  <span className="switch-slider" />
                </label>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="st-method">
                    روش تشخیص شکست
                  </label>
                  <select id="st-method" className="form-input" value={automation.breakDetectionMethod} onChange={(e) => setA('breakDetectionMethod', e.target.value as AutomationSettings['breakDetectionMethod'])}>
                    <option value="Wick">Wick (سایه — High/Low)</option>
                    <option value="Close">Close (قیمت بسته)</option>
                  </select>
                </div>
                <NumField id="st-life" label="عمر چرخه شکست (۰ = LookBack)" value={automation.breakSequenceLifetime} onChange={(v) => setA('breakSequenceLifetime', v ?? 0)} min={0} max={100} step={1} />
                <NumField id="st-batr-l" label="ضریب ATR شکست — لانگ" value={automation.breakAtrMultiplierLong} onChange={(v) => setA('breakAtrMultiplierLong', v ?? 0.2)} min={0.05} max={1} step={0.05} />
                <NumField id="st-batr-s" label="ضریب ATR شکست — شورت" value={automation.breakAtrMultiplierShort} onChange={(v) => setA('breakAtrMultiplierShort', v ?? 0.2)} min={0.05} max={1} step={0.05} />
              </div>
              <div className="toggle-row">
                <div className="toggle-row-left">
                  <i className="ph ph-arrow-u-up-left" aria-hidden />
                  <div>
                    <div className="toggle-label">مدیریت چرخه عمر شکست</div>
                    <div className="toggle-desc">ماشین حالت: شکست → بازیابی → سیگنال (پیشنهادی: فعال)</div>
                  </div>
                </div>
                <label className="switch">
                  <input type="checkbox" checked={automation.enableBreakLifecycleManagement} onChange={(e) => setA('enableBreakLifecycleManagement', e.target.checked)} />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={saveStrategy} disabled={busy}>
                <i className={`ph ${busy ? 'ph-circle-notch spin' : 'ph-check'}`} aria-hidden /> <span>ذخیره تنظیمات استراتژی</span>
              </button>
            </div>
          </div>
        ) : null}

        {/* ============== TAB 3: security ============== */}
        {tab === 'security' ? (
          <div style={{ maxWidth: 520 }}>
            <div className="form-section">
              <div className="form-section-title">
                <i className="ph ph-user-key" aria-hidden /> تغییر نام کاربری و رمز عبور
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="sec-cur">
                  رمز عبور فعلی
                </label>
                <input id="sec-cur" className="form-input" type="password" value={curPassword} onChange={(e) => setCurPassword(e.target.value)} autoComplete="current-password" />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="sec-user">
                    نام کاربری جدید
                  </label>
                  <input id="sec-user" className="form-input" value={newUsername} onChange={(e) => setNewUsername(e.target.value)} autoComplete="username" />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sec-pass">
                    رمز عبور جدید
                  </label>
                  <input id="sec-pass" className="form-input" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />
                </div>
              </div>
              <p className="form-hint">
                پس از تغییر، همه نشست‌های دیگر باطل می‌شوند ( کوکی فعلی شما تمدید می‌شود). رمزها به‌صورت هش شور‌دار ذخیره می‌شوند.
              </p>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={updateCreds} disabled={busy || !curPassword || !newUsername || !newPassword}>
                <i className={`ph ${busy ? 'ph-circle-notch spin' : 'ph-shield-check'}`} aria-hidden /> <span>به‌روزرسانی اعتبارنامه</span>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
