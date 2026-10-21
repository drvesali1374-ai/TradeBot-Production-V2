'use client'

/**
 * SymbolStatsSection (mission §8-UI) — per-symbol closed-trade statistics.
 *
 * ONE component, TWO render contexts:
 *  - Sidebar (desktop ≥1025px): compact table under «آمار معاملات نمادها».
 *  - In-page panel (≤1024px, where the sidebar is an off-canvas drawer):
 *    same DataTable placed right after the symbols panel in the automation
 *    view — never a second table implementation (mission §10).
 *
 * Data contract: GET /api/diagnostics/symbol-stats →
 *   { success, stats: SymbolStat[], basedOnCount, truncated, sourceLimit, fetchedAt }
 *   On failure the server sends { success:false, error, stats: [] } — NEVER
 *   fabricate zero-rows (mission §8.3): show «خطای دریافت آمار» instead and
 *   retry happens on the next refresh (the payload is re-fetched with every
 *   refreshKey bump, i.e. after each cycle run).
 *
 * The server already sorts (closedTrades DESC, netIncome DESC, symbol ASC) —
 * the UI does NOT re-sort (mission §8-UI rule).
 */

import { DataTable, type DataColumn } from '@/modules/common/DataTable'
import { fmtNum, fmtUsdtAmount, pnlColor, shortSymbol } from '@/modules/common/format'
import type { SymbolStat } from '@/core/types'

/** Wire format of GET /api/diagnostics/symbol-stats. */
export interface SymbolStatsPayload {
  success: boolean
  stats: SymbolStat[]
  basedOnCount?: number
  truncated?: boolean
  sourceLimit?: number
  fetchedAt?: number
  /** only present on failure */
  error?: string
  code?: string
}

const UNKNOWN = '—'

/** winRate as a plain Persian-context percent — «57٪», never «+57٪» (a rate is not a PnL). */
function fmtWinRate(n: number): string {
  return `${fmtNum(n, 0)}٪`
}

export function SymbolStatsTable({
  stats,
  variant,
  label,
}: {
  stats: SymbolStatsPayload | null
  /** 'sidebar' → tightest fit; 'panel' → in-page (wider, unit in header) */
  variant: 'sidebar' | 'panel'
  label: string
}) {
  const columns: DataColumn<SymbolStat>[] = [
    {
      key: 'symbol',
      header: 'نماد',
      width: variant === 'sidebar' ? '58px' : '90px',
      ltr: true,
      strong: true,
      render: (s) => <bdi>{shortSymbol(s.symbol)}</bdi>,
    },
    {
      key: 'count',
      header: 'تعداد',
      width: variant === 'sidebar' ? '44px' : '70px',
      align: 'center',
      ltr: true,
      render: (s) => <span className="num">{s.closedTrades}</span>,
    },
    {
      key: 'winRate',
      header: 'نرخ برد',
      width: variant === 'sidebar' ? '50px' : '80px',
      align: 'center',
      ltr: true,
      render: (s) => <bdi className="num">{fmtWinRate(s.winRate)}</bdi>,
    },
    {
      key: 'netIncome',
      header: variant === 'panel' ? 'درآمد خالص (USDT)' : 'درآمد خالص',
      align: 'end',
      ltr: true,
      render: (s) => (
        <bdi className="num" style={{ fontWeight: 700, color: pnlColor(s.netIncome) }} title="درآمد خالص به USDT (پس از کارمزد)">
          {fmtUsdtAmount(s.netIncome)}
        </bdi>
      ),
    },
  ]

  return (
    <DataTable
      label={label}
      columns={columns}
      rows={stats?.stats ?? []}
      rowKey={(s) => s.symbol}
      compact
      minWidth={variant === 'sidebar' ? '240px' : '340px'}
      maxHeight={variant === 'sidebar' ? 300 : 340}
      emptyState={
        stats == null ? (
          <div className="empty-state" style={{ padding: 14 }}>
            <i className="ph ph-circle-notch spin" aria-hidden />
            در حال دریافت آمار…
          </div>
        ) : !stats.success ? (
          <div className="empty-state" style={{ padding: 14, color: 'var(--danger)' }}>
            <i className="ph-fill ph-warning-circle" aria-hidden />
            خطای دریافت آمار
          </div>
        ) : (
          <div className="empty-state" style={{ padding: 14 }}>
            <i className="ph ph-inbox" aria-hidden />
            داده‌ای موجود نیست
          </div>
        )
      }
    />
  )
}

/**
 * Coverage note (mission §8-UI): «بر اساس N معامله اخیر» — visible whenever
 * the fetch succeeded, plus «(ممکن است کامل نباشد)» when the exchange
 * history hit the live cap (truncated). Hidden while loading/errored.
 */
export function SymbolStatsCoverageNote({ stats }: { stats: SymbolStatsPayload | null }) {
  if (!stats?.success) return null
  const n = stats.basedOnCount
  return (
    <p style={{ fontSize: 10.5, color: 'var(--text-muted)', margin: '6px 2px 0', lineHeight: 1.6 }}>
      بر اساس {n != null ? <span className="num">{n}</span> : UNKNOWN} معامله اخیر
      {stats.truncated ? ' (ممکن است کامل نباشد)' : ''}
      {' '}— درآمد خالص به USDT پس از کارمزد
    </p>
  )
}
