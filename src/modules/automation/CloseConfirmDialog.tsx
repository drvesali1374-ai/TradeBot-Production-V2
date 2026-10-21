'use client'

/**
 * CloseConfirmDialog (mission §1.1) — confirmation gate before a REAL
 * close order is sent to the exchange.
 *
 * Safety rules (mission acceptance):
 *  - opening the dialog performs ZERO network activity; only the
 *    «بستن پوزیشن» button fires the POST
 *  - Escape / backdrop / «انصراف» close without any request
 *  - while the POST is in flight («submitting») BOTH buttons are
 *    disabled and Escape/backdrop are vetoed → no double submit,
 *    no lost response
 *  - `position` comes from the parent's `closeTarget` state and the
 *    parent clears it on close → no stale position on next open
 *
 * Built on the shared shadcn dialog primitive (src/components/ui/dialog),
 * themed with the project's own vars/classes (btn-*, badge-*, .modal-actions,
 * Phosphor icons) — consistent with the rest of the dashboard.
 */
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fmtPct, fmtQty, fmtUsd, pnlColor, shortSymbol } from '@/modules/common/format'
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

/** One label/value row of the position summary. */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        padding: '9px 2px',
        borderTop: '1px solid var(--border-soft)',
      }}
    >
      <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, textAlign: 'left' }}>{value}</span>
    </div>
  )
}

export function CloseConfirmDialog({ position, submitting, onConfirm, onOpenChange }: CloseConfirmDialogProps) {
  const isLong = position?.side === 'LONG'
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
          <div dir="rtl" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <Row label="نماد" value={<bdi style={{ fontWeight: 800 }}>{shortSymbol(position.symbol)}</bdi>} />
            <Row
              label="جهت"
              value={
                <span className={isLong ? 'long' : 'short'} style={{ fontWeight: 700 }}>
                  {isLong ? 'لانگ' : 'شورت'}
                </span>
              }
            />
            <Row
              label="مقدار پوزیشن"
              value={
                position.qty != null ? (
                  <bdi className="num">{fmtQty(position.qty)}</bdi>
                ) : (
                  <span style={{ color: 'var(--text-muted)' }}>نامشخص</span>
                )
              }
            />
            <Row
              label="درصد سود/زیان فعلی"
              value={
                <bdi className="num" style={{ fontSize: 18, fontWeight: 800, color: pnlColor(position.unrealizedPnL) }}>
                  {fmtPct(position.profitRate)}
                </bdi>
              }
            />
            <Row
              label="مبلغ دلاری سود/زیان فعلی"
              value={
                <bdi className="num" style={{ fontSize: 16, fontWeight: 700, color: pnlColor(position.unrealizedPnL) }}>
                  {fmtUsd(position.unrealizedPnL)}
                </bdi>
              }
            />
          </div>
        ) : null}

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
