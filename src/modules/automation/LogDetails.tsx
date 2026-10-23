'use client'

/**
 * LogExpandedDetails (item 2 redesign) — the unified cycle/log table's
 * expanded row. The mission-3 version dumped raw English detail keys in a
 * loose list; this redesign presents the SAME persisted data in an
 * organized, user-friendly layout:
 *
 *   1. head line      — status badge + process name + «چرخه جاری» badge
 *   2. full message   — one clean box (never clipped here)
 *   3. meta chips     — زمان (bold Jalali) · نماد · منبع · مرحله · مدت اجرا
 *   4. cycle id row   — full id (bold) + copy button
 *   5. «جزئیات فنی»   — every persisted detail key TRANSLATED to Persian,
 *                       values typed: dates → bold Jalali datetime, booleans
 *                       → ✓/✗ chips, risk-control lists → pass/fail chips,
 *                       ids → mono, numbers → formatted, objects → JSON block
 *
 * Unknown keys fall back to the raw key name (never dropped) — a future
 * engine field is still visible, just untranslated.
 */
import { fmtDateTime, fmtDurationFa, fmtNum } from '@/modules/common/format'
import type { LogRecord } from '@/core/types'

/* ------------------------------------------------------------------ */
/* Persian label dictionaries                                          */
/* ------------------------------------------------------------------ */

/** Detail-key → Persian label (every key the cycle engine persists). */
const DETAIL_LABELS: Record<string, string> = {
  settingsVersion: 'نسخه تنظیمات',
  hasCredentials: 'اعتبارنامه صرافی',
  hint: 'راهنما',
  heldBy: 'قفل در اختیار',
  symbol: 'نماد',
  tradeWaitTime: 'زمان انتظار (دقیقه)',
  total: 'تعداد کل',
  closed: 'بسته‌شده',
  forming: 'کندل در حال شکل‌گیری',
  lastClosedAt: 'آخرین کندل بسته',
  signals: 'تعداد سیگنال',
  lastPrice: 'آخرین قیمت',
  strategy: 'استراتژی',
  signalId: 'شناسه سیگنال',
  status: 'وضعیت',
  side: 'جهت',
  price: 'قیمت',
  tp: 'حد سود (TP)',
  sl: 'حد ضرر (SL)',
  confirmedAt: 'زمان تأیید سیگنال',
  ageHours: 'عمر سیگنال (ساعت)',
  expirationHours: 'انقضای سیگنال (ساعت)',
  fills: 'معاملات بازکردن',
  lastOpenPrice: 'آخرین قیمت ورود',
  priceSource: 'منبع قیمت',
  free: 'موجودی آزاد',
  openPositions: 'پوزیشن‌های باز (کل)',
  symbolPositions: 'پوزیشن‌های باز نماد',
  errors: 'خطاها',
  controls: 'کنترل‌های ریسک',
  math: 'محاسبات',
  newMargin: 'مارجین جدید',
  leverage: 'اهرم',
  orderId: 'شناسه سفارش',
  qty: 'مقدار',
  margin: 'مارجین',
  tpslConfirmed: 'ثبت TP/SL',
  tpslError: 'خطای TP/SL',
  executionRequestedAt: 'زمان درخواست اجرا',
  orderSubmittedAt: 'زمان ثبت سفارش',
  writes: 'عملیات نوشتن',
  reads: 'عملیات خواندن',
  control: 'کنترل',
  passed: 'نتیجه',
}

/** Risk-control ids (src/core/risk/controls.ts) → Persian. */
const CONTROL_LABELS: Record<string, string> = {
  SAFE_ASSET: 'دارایی امن',
  PRICE_DISTANCE: 'فاصله قیمت',
  MAX_MARGIN: 'سقف مارجین',
  POSITIVE_MARGIN: 'مارجین مثبت',
  SAME_DIRECTION_CANDLES: 'کندل هم‌جهت',
}

/** Enum-ish values worth translating in place. */
const VALUE_LABELS: Record<string, string> = {
  PENDING: 'در انتظار',
  OPENED: 'باز شده',
  EXPIRED: 'منقضی شده',
  NOT_OPENED: 'باز نشد',
  Long: 'لانگ',
  Short: 'شورت',
  ok: 'موفق',
  skipped: 'رد شد',
  warning: 'هشدار',
  failed: 'خطا',
}

const UNKNOWN = '—'
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

/** Keys whose numeric value is an epoch-ms timestamp. */
function isDateKey(key: string): boolean {
  return /At$/.test(key) || key === 'time' || key === 'closeTime' || key === 'openTime'
}

export const SOURCE_LABELS: Record<string, string> = {
  manual: 'دستی',
  cron: 'کرون',
  system: 'سیستم',
}

/* ------------------------------------------------------------------ */
/* Typed value renderer                                                */
/* ------------------------------------------------------------------ */

function renderValue(key: string, v: unknown): React.ReactNode {
  if (v == null) return <span style={{ color: 'var(--text-muted)' }}>نامشخص</span>

  if (typeof v === 'boolean') {
    return (
      <span className={`log-bool ${v ? 'yes' : 'no'}`}>
        <i className={`ph ${v ? 'ph-check-bold' : 'ph-x-bold'}`} aria-hidden />
        {v ? 'بله' : 'خیر'}
      </span>
    )
  }

  // risk-control pass/fail list (step «کنترل ریسک»)
  if (key === 'controls' && Array.isArray(v)) {
    const items = v.filter(
      (x): x is { control?: unknown; passed?: unknown } => typeof x === 'object' && x !== null,
    )
    if (items.length) {
      return (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, direction: 'rtl', justifyContent: 'flex-end' }}>
          {items.map((x, i) => {
            const ctl = String(x.control ?? '')
            const passed = x.passed === true
            return (
              <span className={`log-ctl ${passed ? 'pass' : 'fail'}`} key={`${ctl}-${i}`}>
                <i className={`ph ${passed ? 'ph-check' : 'ph-x'}`} aria-hidden />
                {CONTROL_LABELS[ctl] ?? ctl}
              </span>
            )
          })}
        </span>
      )
    }
  }

  // ISO-8601 strings (persisted timestamps)
  if (typeof v === 'string' && ISO_RE.test(v)) {
    return <span className="cell-dt num" style={{ direction: 'rtl', unicodeBidi: 'isolate' }}>{fmtDateTime(v)}</span>
  }

  // epoch-ms numbers on date keys
  if (typeof v === 'number' && isDateKey(key) && Number.isFinite(v) && v > 1_000_000_000) {
    return <span className="cell-dt num" style={{ direction: 'rtl', unicodeBidi: 'isolate' }}>{fmtDateTime(v)}</span>
  }

  // ids → mono, no separators
  if (typeof v === 'number' && /Id$/i.test(key)) {
    return <span className="mono" style={{ fontSize: 11.5 }}>{String(v)}</span>
  }
  if (typeof v === 'string' && /Id$/i.test(key)) {
    return <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>{v}</span>
  }

  // plain numbers
  if (typeof v === 'number') {
    return <span className="num">{fmtNum(v, 6)}</span>
  }

  // translatable enum-ish strings
  if (typeof v === 'string' && VALUE_LABELS[v]) {
    return <span style={{ direction: 'rtl' }}>{VALUE_LABELS[v]}</span>
  }

  // strategy / price-source style strings stay as-is
  if (typeof v === 'string') {
    return <span title={v} style={{ wordBreak: 'break-word' }}>{v}</span>
  }

  // anything else (nested objects, arrays) → readable JSON
  return <pre className="log-json">{JSON.stringify(v, null, 2)}</pre>
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export function parseLogDetails(d: LogRecord['details']): Record<string, unknown> | null {
  if (d == null) return null
  if (typeof d === 'object') return d as Record<string, unknown>
  try {
    const parsed = JSON.parse(d)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export interface LogExpandedDetailsProps {
  log: LogRecord
  /** row belongs to the cycle shown in the summary header */
  isCurrentCycle: boolean
  /** clipboard helper owned by the view (toast on success/failure) */
  onCopy: (text: string, label: string) => void
  /** status badge meta (label + class) — provided by the view's map */
  statusMeta: { text: string; cls: string }
}

export function LogExpandedDetails({ log, isCurrentCycle, onCopy, statusMeta }: LogExpandedDetailsProps) {
  const details = parseLogDetails(log.details)
  const entries = details ? Object.entries(details) : []
  const process = log.process ?? (log.action === 'automation_cycle' ? 'چرخه اتوماسیون' : log.action)

  return (
    <div dir="rtl">
      {/* 1 — head: status + process + current-cycle badge */}
      <div className="log-detail-head">
        <span className={`badge ${statusMeta.cls}`} style={{ fontSize: 10, padding: '2px 9px' }}>
          {statusMeta.text}
        </span>
        <span className="log-head-title">{process}</span>
        {isCurrentCycle ? (
          <span className="badge badge-accent" style={{ fontSize: 9.5, padding: '1px 7px' }}>چرخه جاری</span>
        ) : null}
      </div>

      {/* 2 — the full, unclipped message */}
      <div className="log-kv-box" style={{ marginBottom: 10 }}>
        <div className="log-kv-box-label">پیام</div>
        <div className="log-kv-box-val rtl-val" style={{ fontWeight: 600, fontSize: 12.5 }}>
          {log.message}
        </div>
      </div>

      {/* 3 — meta chips */}
      <div className="log-detail-chips">
        <span className="log-chip" title="زمان ثبت رویداد">
          <i className="ph ph-clock" aria-hidden /> زمان <b className="cell-dt num" style={{ direction: 'rtl', unicodeBidi: 'isolate' }}>{fmtDateTime(log.created_at)}</b>
        </span>
        {log.symbol ? (
          <span className="log-chip" title="نماد">
            <i className="ph ph-currency-circle-dollar" aria-hidden /> نماد <b><bdi>{log.symbol}</bdi></b>
          </span>
        ) : null}
        <span className="log-chip" title="منبع اجرا">
          <i className="ph ph-broadcast" aria-hidden /> منبع <b>{SOURCE_LABELS[log.source ?? 'system'] ?? log.source ?? UNKNOWN}</b>
        </span>
        {log.step != null ? (
          <span className="log-chip" title="شماره مرحله در چرخه">
            <i className="ph ph-steps" aria-hidden /> مرحله <b className="num">{log.step}</b>
          </span>
        ) : null}
        {log.durationMs != null ? (
          <span className="log-chip" title="مدت اجرای این مرحله">
            <i className="ph ph-timer" aria-hidden /> مدت اجرا <b>{fmtDurationFa(log.durationMs)}</b>
          </span>
        ) : null}
      </div>

      {/* 4 — cycle id + copy */}
      <div className="log-kv-box" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: entries.length ? 0 : 0 }}>
        <div style={{ minWidth: 0 }}>
          <div className="log-kv-box-label">شناسه چرخه</div>
          <span className="mono cell-dt" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
            {log.cycleId ?? UNKNOWN}
          </span>
        </div>
        {log.cycleId ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => onCopy(log.cycleId!, 'شناسه چرخه')}
            title="کپی شناسه"
            aria-label="کپی شناسه چرخه"
            style={{ flexShrink: 0 }}
          >
            <i className="ph ph-copy" aria-hidden />
          </button>
        ) : null}
      </div>

      {/* 5 — translated technical details */}
      {entries.length ? (
        <div className="log-detail-section">
          <div className="log-detail-section-title">
            <i className="ph ph-code" aria-hidden /> جزئیات فنی
          </div>
          <div className="log-kv-grid">
            {entries.map(([k, v]) => (
              <div className="log-kv-box" key={k}>
                <div className="log-kv-box-label" title={k}>
                  {DETAIL_LABELS[k] ?? k}
                </div>
                <div className="log-kv-box-val">{renderValue(k, v)}</div>
              </div>
            ))}
          </div>
        </div>
      ) : typeof log.details === 'string' && log.details ? (
        <div className="log-detail-section">
          <div className="log-detail-section-title">
            <i className="ph ph-code" aria-hidden /> جزئیات فنی
          </div>
          <div className="log-kv-box">
            <div className="log-kv-box-label">توضیح</div>
            <div className="log-kv-box-val">{log.details}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
