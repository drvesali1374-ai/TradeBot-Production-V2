'use client'

/**
 * DataTable — the ONE shared table component (mission §1).
 *
 * Rules enforced here (so no table re-implements them differently):
 *  - thead + tbody are parts of the SAME real <table> → header and body
 *    columns can never drift apart (no two-table hacks, no sync JS).
 *  - horizontal scroll lives on the wrapper (.table-scroll), so sticky
 *    header and body always scroll together.
 *  - thead is position:sticky inside .table-scroll (opaque background,
 *    z-index) → headers stay visible while rows scroll vertically.
 *  - alignment is per-column, driven by data type: numbers/prices are
 *    LTR-isolated and end-aligned; text follows page RTL.
 *  - empty/invalid values render as «نامشخص» — never fabricated zeros.
 */

export type ColumnAlign = 'start' | 'end' | 'center'

export interface DataColumn<T> {
  /** unique key (also used for aria-sort in the future) */
  key: string
  header: string
  /** recommended width: CSS min-width for the col element */
  width?: string
  align?: ColumnAlign
  /** visually bold (e.g. symbol names) */
  strong?: boolean
  render: (row: T) => React.ReactNode
  /** hint that the cell holds a raw Latin token (symbol/ids) → isolate LTR */
  ltr?: boolean
}

interface DataTableProps<T> {
  columns: DataColumn<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  /** minimum table width — below container width it scrolls horizontally */
  minWidth?: string
  /** vertical limit — the thead sticks while the body scrolls inside */
  maxHeight?: number | string
  /** row click (used by the log table to expand a row) */
  onRowClick?: (row: T, index: number) => void
  /** mark a row as expanded (log details) */
  isRowExpanded?: (row: T) => boolean
  /** extra render for an expanded row (full-width details cell) */
  renderExpanded?: (row: T) => React.ReactNode
  /**
   * Tighter cell padding for narrow panels (mission §9.2/§10 — compact
   * tables must fit their panel without horizontal scroll at desktop widths).
   */
  compact?: boolean
  /**
   * table-layout: fixed — colgroup widths become authoritative so long
   * message text clips with ellipsis instead of forcing horizontal scroll
   * (mission §3.2: the unified table keeps ALL 6 columns visible).
   */
  fixed?: boolean
  /**
   * Per-row class hook (mission §3.2 — subtle accent for the rows that
   * belong to the cycle currently shown in the summary header).
   */
  rowClassName?: (row: T) => string | undefined
  /** accessible label */
  label: string
  emptyState?: React.ReactNode
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  minWidth,
  maxHeight,
  onRowClick,
  isRowExpanded,
  renderExpanded,
  compact,
  fixed,
  rowClassName,
  label,
  emptyState,
}: DataTableProps<T>) {
  const clickable = typeof onRowClick === 'function'
  const expandedSet = typeof isRowExpanded === 'function'

  return (
    <div
      className="table-scroll"
      style={maxHeight != null ? { maxHeight } : undefined}
      data-count={rows.length}
    >
      <table
        className={`tb-table${compact ? ' tb-compact' : ''}`}
        style={{ ...(minWidth ? { minWidth } : undefined), ...(fixed ? { tableLayout: 'fixed' as const } : undefined) }}
        aria-label={label}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
          {/* the sr-only «جزئیات» header column (expandable tables) must be
              ZERO wide — an auto col would steal ~16px from the last real
              column and leave a phantom gap column at the table's end */}
          {expandedSet ? <col style={{ width: 0 }} /> : null}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                style={{ textAlign: c.align === 'end' ? 'left' : c.align === 'center' ? 'center' : undefined }}
              >
                {c.header}
              </th>
            ))}
            {expandedSet ? <th scope="col" className="sr-only">جزئیات</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr className="tb-empty-row">
              <td colSpan={columns.length + (expandedSet ? 1 : 0)}>
                {emptyState ?? (
                  <div className="empty-state" style={{ padding: 18 }}>
                    <i className="ph ph-inbox" aria-hidden />
                    داده‌ای موجود نیست
                  </div>
                )}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => {
              const expanded = expandedSet ? isRowExpanded!(row) : false
              return (
                <FragmentRow
                  key={rowKey(row, i)}
                  row={row}
                  index={i}
                  columns={columns}
                  clickable={clickable}
                  onRowClick={onRowClick}
                  expanded={expanded}
                  renderExpanded={renderExpanded}
                  rowClassName={rowClassName}
                />
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}

/* separate inner component so expanded rows keep keys stable */
function FragmentRow<T>({
  row,
  index,
  columns,
  clickable,
  onRowClick,
  expanded,
  renderExpanded,
  rowClassName,
}: {
  row: T
  index: number
  columns: DataColumn<T>[]
  clickable: boolean
  onRowClick?: (row: T, index: number) => void
  expanded: boolean
  renderExpanded?: (row: T) => React.ReactNode
  rowClassName?: (row: T) => string | undefined
}) {
  const extra = rowClassName?.(row)
  return (
    <>
      <tr
        className={`${clickable ? 'tb-clickable' : ''}${extra ? ` ${extra}` : ''}`.trim() || undefined}
        onClick={clickable ? () => onRowClick?.(row, index) : undefined}
        data-expanded={expanded || undefined}
      >
        {columns.map((c) => (
          <td
            key={c.key}
            style={{ textAlign: c.align === 'end' ? 'left' : c.align === 'center' ? 'center' : undefined }}
            dir={c.ltr ? 'ltr' : undefined}
          >
            {c.strong ? <b>{c.render(row)}</b> : c.render(row)}
          </td>
        ))}
      </tr>
      {expanded && renderExpanded ? (
        <tr className="tb-details-row">
          {/* mission §10 audit: colspan must cover the extra sr-only
              «جزئیات» header column, otherwise header/body column counts
              drift apart on expandable tables */}
          <td colSpan={columns.length + 1}>{renderExpanded(row)}</td>
        </tr>
      ) : null}
    </>
  )
}
