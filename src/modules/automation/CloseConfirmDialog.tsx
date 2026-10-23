'use client'

/**
 * CloseConfirmDialog (mission §1.1 + item 1 redesign) — confirmation gate
 * before a REAL close order is sent to the exchange.
 *
 * Safety rules (unchanged — mission §1.1 acceptance):
 *  - opening the dialog performs ZERO network activity; only the
 *    «بستن پوزیشن» button fires the POST
 *  - Escape / backdrop / «انصراف» close without any request
 *  - while the POST is in flight («submitting») BOTH buttons are
 *    disabled and Escape/backdrop are vetoed → no double submit,
 *    no lost response
 *  - `position` comes from the parent's `closeTarget` state and the
 *    parent clears it on close → no stale position on next open
 *
 * Item 1 redesign — an organized, readable summary instead of a loose
 * label/value list:
 *   1. symbol banner (icon + symbol + direction badge, direction-tinted)
 *   2. compact 2×3 info grid (entry / mark / qty / leverage / margin / TP-SL)
 *   3. PnL highlight strip (percent and USDT amount, SAME size — item 8)
 *   4. warning strip + RTL action row
 * All values are LTR-isolated numerics; missing exchange values render as
 * «نامشخص» — never fabricated zeros.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fmtPct, fmtQty, fmtUsd, fmtUsdtAmount, pnlColor, shortSymbol, tpslLabel, fmtTpsl } from '@/modules/common/format'
import type { OpenPosition } from '@/core/types'

interface CloseConfirmDialogProps {
  /** the position awaiting confirmation — null = dialog closed */
  position: OpenPosition | null
  /** POST /api/positions/close is in flight → buttons disabled, dismiss vetoed */
  submitting: boolean
  /** the ONLY path that may trigger network activity */
  onConfirm: () => void
  /** controlled open change — the parent also vetoes dismissals while submitting */
  onOpenChange: (open: boolean) => void
}

const UNKNOWN_V = <span style={{ color: 'var(--text-muted)' }}>نامشخص</span>

/** One compact cell of the info grid. */
function InfoCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="ccd-cell">
      <div className="ccd-cell-label">{label}</div>
      <div className="ccd-cell-val">{value}</div>
    </div>
  )
}

export function CloseConfirmDialog({ position, submitting, onConfirm, onOpenChange }: CloseConfirmDialogProps) {
  const isLong = position?.side === 'LONG'
  const dirHue = isLong ? 'var(--success)' : 'var(--danger)'
  const dirSoft = isLong ? 'var(--success-soft)' : 'var(--danger-soft)'

  const tp = position ? tpslLabel(position.takeProfit, position.tpslStatus) : null
  const sl = position ? tpslLabel(position.stopLoss, position.tpslStatus) : null

  return (
    <Dialog open={position !== null} onOpenChange={onOpenChange}>
      <DialogContent
        /* project card look (default tailwind vars render fine but the
           dashboard cards are --bg-card with the theme radius) */
        style={{ background: 'var(--bg-card)', borderRadius: 'var(--radius)' }}
        /* veto Escape/backdrop dismissal while the close POST is in flight —
           the parent also ignores onOpenChange(false) when submitting */
        onEscapeKeyDown={(e) => {
          if (submitting) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (submitting) e.preventDefault()
        }}
        showCloseButton={false}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-end gap-2 text-right leading-relaxed">
            <i className="ph-fill ph-warning-circle" style={{ color: 'var(--warning)', fontSize: 20 }} aria-hidden />
            تأیید بستن پوزیشن
          </DialogTitle>
          <DialogDescription className="text-right">این عملیات قابل بازگشت نیست — مشخصات پوزیشن را بررسی کنید.</DialogDescription>
        </DialogHeader>

        {position ? (
          <div dir="rtl" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* 1 — symbol banner: icon + symbol + direction, tinted by side */}
            <div
              className="ccd-symbol-banner"
              style={{ borderColor: `color-mix(in srgb, ${dirHue} 45%, transparent)`, background: dirSoft }}
            >
              <span className="ccd-symbol-icon" style={{ background: dirHue }}>
                <i className={`ph-fill ${isLong ? 'ph-trend-up' : 'ph-trend-down'}`} aria-hidden />
              </span>
              <bdi className="ccd-symbol-name">{shortSymbol(position.symbol)}</bdi>
              <span
                className="badge"
                style={{
                  fontSize: 11,
                  fontWeight: 800,
                  color: dirHue,
                  background: 'var(--bg-card)',
                  border: `1px solid color-mix(in srgb, ${dirHue} 45%, transparent)`,
                  padding: '3px 10px',
                }}
              >
                {isLong ? 'لانگ (Long)' : 'شورت (Short)'}
              </span>
            </div>

            {/* 2 — compact info grid */}
            <div className="ccd-grid">
              <InfoCell
                label="قیمت ورود"
                value={position.entryPrice != null ? <span className="mono">{fmtTpsl(position.entryPrice)}</span> : UNKNOWN_V}
              />
              <InfoCell
                label="قیمت فعلی"
                value={position.markPrice != null ? <span className="mono">{fmtTpsl(position.markPrice)}</span> : UNKNOWN_V}
              />
              <InfoCell
                label="مقدار پوزیشن"
                value={position.qty != null ? <bdi className="num">{fmtQty(position.qty)}</bdi> : UNKNOWN_V}
              />
              <InfoCell
                label="اهرم"
                value={position.leverage != null ? <bdi className="num">{position.leverage}x</bdi> : UNKNOWN_V}
              />
              <InfoCell
                label="مارجین"
                value={position.margin != null ? <span className="mono">{fmtUsd(position.margin)}</span> : UNKNOWN_V}
              />
              <InfoCell
                label="حد سود / حد ضرر"
                value={
                  <span className="mono" style={{ fontSize: 11.5, lineHeight: 1.6, display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                    <span style={{ color: tp?.kind === 'price' ? 'var(--success)' : 'var(--text-muted)' }}>
                      TP: {tp ? tp.text : 'نامشخص'}
                    </span>
                    <span style={{ color: sl?.kind === 'price' ? 'var(--danger)' : 'var(--text-muted)' }}>
                      SL: {sl ? sl.text : 'نامشخص'}
                    </span>
                  </span>
                }
              />
            </div>

            {/* 3 — PnL highlight: percent and USDT at the SAME size (item 8) */}
            {position.unrealizedPnL != null || position.profitRate != null ? (
              <div
                className="ccd-pnl"
                style={{ borderColor: `color-mix(in srgb, ${pnlColor(position.unrealizedPnL)} 40%, transparent)` }}
              >
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)' }}>سود/زیان فعلی</span>
                <span className="mono" style={{ fontSize: 15, fontWeight: 800, color: pnlColor(position.unrealizedPnL) }}>
                  {position.profitRate != null ? fmtPct(position.profitRate) : '—'}{' '}
                  <span style={{ fontSize: 15 }}>
                    (<bdi className="num">{position.unrealizedPnL != null ? `${fmtUsdtAmount(position.unrealizedPnL)} USDT` : '—'}</bdi>)
                  </span>
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* warning strip */}
        <div className="badge badge-warning" style={{ width: '100%', justifyContent: 'flex-start', padding: '10px 14px', borderRadius: 12, gap: 8 }} role="alert">
          <i className="ph-fill ph-warning" aria-hidden />
          <span style={{ textAlign: 'right' }}>با تأیید، درخواست بستن واقعی این پوزیشن به صرافی ارسال می‌شود.</span>
        </div>

        {/* project modal pattern (.modal-actions): RTL row → «انصراف» right, destructive left */}
        <div className="modal-actions" style={{ marginBottom: 0 }}>
          <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            انصراف
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm} disabled={submitting} aria-busy={submitting}>
            <i className={`ph ${submitting ? 'ph-circle-notch spin' : 'ph-x'}`} aria-hidden />
            <span>{submitting ? 'در حال بستن…' : 'بستن پوزیشن'}</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
