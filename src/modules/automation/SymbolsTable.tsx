'use client'

/**
 * SymbolsTable — the «نمادها و زمان‌بندی» table (mission 5-b, item 2).
 *
 * The ARRAY ORDER of the symbols IS the cycle priority: the engine picks
 * the first ready symbol, so index 0 = highest priority.
 *
 * Reordering is offered in two complementary ways:
 *  - Up/down icon buttons per row — the keyboard-accessible path (native
 *    buttons, disabled at bounds, aria-labels in Persian).
 *  - A drag handle (`ph-dots-six-vertical`) using POINTER EVENTS — works
 *    with mouse, touch AND pen (native HTML5 DnD does not work on touch).
 *    `touch-action: none` on the handle (globals.css) keeps a touch-drag
 *    from scrolling the page; the whole table gets `user-select: none`
 *    while a drag is active (`.tb-dragging`).
 *
 * Drag semantics (quantized steps): the dragged row follows the pointer via
 * `transform: translateY(dy)`; when its visual center crosses the vertical
 * midpoint of a neighboring row, the two entries LIVE-SWAP in local state
 * and the drag baseline resets so the row keeps tracking the pointer. The
 * final order is persisted once on pointerup via
 * `POST /api/automation/symbols { action:'reorder', order: names }`
 * (optimistic local update; on failure the order reverts + danger toast).
 * pointercancel only clears the visuals — the already live-swapped local
 * order stays (no persist), per spec.
 *
 * Column «قفل چرخه» (item 2b): minutes until the symbol unlocks for a cycle
 * (lastCycleTime + tradeWaitTime·60s − now) — «آزاد» badge when ready,
 * «در اجرا» while running, otherwise Persian-digit minutes + clock icon.
 * A 15s interval ticker keeps the values live.
 *
 * Visual parity with the other tables comes from reusing the shared
 * classes `tb-table tb-compact` + the `.table-scroll` wrapper — the shared
 * DataTable component itself is NOT touched.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiPost } from '@/modules/common/api'
import { useToast } from '@/modules/common/toast'
import { fmtDateTime } from '@/modules/common/format'
import type { SymbolEntry } from '@/core/types'

/** «نامشخص» marker — same convention as AutomationView. */
const UNKNOWN = '—'

/** Persian digits, no grouping separators («۴۲», «۱۲۸»). */
const faNumFmt = new Intl.NumberFormat('fa-IR', { useGrouping: false })
function faNum(n: number): string {
  return faNumFmt.format(n)
}

/**
 * Two-line Jalali datetime cell (copied from the old AutomationView
 * renderer): the SINGLE fmtDateTime value split at its «, » separator so
 * the column stays ~74px wide — no mid-token break, no h-scroll.
 */
function renderCellDateTime(value: number | null) {
  const text = fmtDateTime(value)
  if (text === UNKNOWN || !text.includes(', ')) {
    return <span className="cell-dt num" style={{ fontSize: 10, display: 'inline-block', direction: 'rtl', unicodeBidi: 'isolate' }}>{text}</span>
  }
  const [date, time] = text.split(', ')
  return (
    <span className="cell-dt num" style={{ fontSize: 10, display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.5, direction: 'rtl', unicodeBidi: 'isolate' }} title={text}>
      <span style={{ whiteSpace: 'nowrap' }}>{date}،</span>
      <span style={{ whiteSpace: 'nowrap' }}>{time}</span>
    </span>
  )
}

interface SymbolsTableProps {
  /** authoritative list from the status payload (order = cycle priority) */
  symbols: SymbolEntry[]
  /** minutes a symbol must wait between cycles (status.tradeWaitTime) */
  tradeWaitTime: number
  /** remove action — stays owned by AutomationView (add-input row there) */
  onRemove: (name: string) => void
  /** keeps the parent's status.symbols in sync with local reorders */
  onSymbolsChange: (symbols: SymbolEntry[]) => void
}

interface DragInfo {
  pointerId: number
  /** current index of the dragged row inside the live rows state */
  index: number
  /** pointer clientY at the last baseline reset (dy = clientY − baseY) */
  baseY: number
  /** names signature at drag start — pointerup only persists on change */
  startSig: string
  /** rows at drag start — the revert target if the persist POST fails */
  startRows: SymbolEntry[]
}

export function SymbolsTable({ symbols, tradeWaitTime, onRemove, onSymbolsChange }: SymbolsTableProps) {
  const { show } = useToast()

  /* local order state — derived from the authoritative prop */
  const [rows, setRows] = useState<SymbolEntry[]>(symbols)
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  /* live «قفل چرخه» clock (item 2b) — ticks every 15s, cleaned on unmount */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])

  /* drag state: ref = logic, dragUi = the visual transform re-render */
  const dragRef = useRef<DragInfo | null>(null)
  const [dragUi, setDragUi] = useState<{ index: number; dy: number } | null>(null)
  const draggedElRef = useRef<HTMLTableRowElement | null>(null)
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([])
  const persistingRef = useRef(false)

  const dragging = dragUi !== null

  /* (re)derive local order when the authoritative prop changes (refresh,
     add/remove/clear-errors). Mid-drag only a STRUCTURAL change (a symbol
     disappeared, e.g. a second finger tapped remove) aborts the drag. */
  useEffect(() => {
    if (!dragRef.current) {
      setRows(symbols)
      return
    }
    const propSet = new Set(symbols.map((s) => s.name))
    if (rowsRef.current.some((s) => !propSet.has(s.name))) {
      dragRef.current = null
      draggedElRef.current = null
      setDragUi(null)
      setRows(symbols)
    }
  }, [symbols])

  const sigOf = useCallback((list: SymbolEntry[]) => list.map((s) => s.name).join('|'), [])

  /**
   * Optimistic reorder + persist. `prev` is the revert target: on POST
   * failure both local and parent state roll back and a danger toast is
   * shown; on success the SERVER's returned list is authoritative for
   * both. A persist already in flight swallows the POST (rapid double
   * reorder) — the next status refresh re-syncs; display stays consistent.
   */
  const applyOrder = useCallback(
    async (next: SymbolEntry[], prev: SymbolEntry[]) => {
      rowsRef.current = next
      setRows(next)
      onSymbolsChange(next)
      if (persistingRef.current) return
      persistingRef.current = true
      try {
        const r = await apiPost<{ success: boolean; symbols: SymbolEntry[] }>('/api/automation/symbols', {
          action: 'reorder',
          order: next.map((s) => s.name),
        })
        rowsRef.current = r.symbols
        setRows(r.symbols)
        onSymbolsChange(r.symbols)
        show('نمادها', 'ترتیب نمادها ذخیره شد', 'success')
      } catch (e) {
        rowsRef.current = prev
        setRows(prev)
        onSymbolsChange(prev)
        show('نمادها', e instanceof Error ? `ذخیره ترتیب ناموفق بود — ${e.message}` : 'ذخیره ترتیب نمادها ناموفق بود', 'danger')
      } finally {
        persistingRef.current = false
      }
    },
    [onSymbolsChange, show]
  )

  /* keyboard path — up/down buttons (disabled at bounds) */
  const moveBy = useCallback(
    (index: number, dir: -1 | 1) => {
      const cur = rowsRef.current
      const j = index + dir
      if (j < 0 || j >= cur.length) return
      const next = [...cur]
      const tmp = next[index]
      next[index] = next[j]
      next[j] = tmp
      void applyOrder(next, cur)
    },
    [applyOrder]
  )

  /* pointer path — handle pointerdown starts the drag */
  const startDrag = (e: React.PointerEvent<HTMLButtonElement>, index: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (dragRef.current || rowsRef.current.length < 2) return
    e.preventDefault() // no text-selection drag start
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* some engines — window listeners below keep the drag alive anyway */
    }
    const tr = (e.currentTarget as HTMLElement).closest('tr') as HTMLTableRowElement | null
    draggedElRef.current = tr
    dragRef.current = {
      pointerId: e.pointerId,
      index,
      baseY: e.clientY,
      startSig: sigOf(rowsRef.current),
      startRows: rowsRef.current,
    }
    setDragUi({ index, dy: 0 })
  }

  /* move/up/cancel — window listeners while a drag is active (they fire
     whether or not the pointer capture survived the live DOM reorders). */
  useEffect(() => {
    if (!dragging) return

    /** live swap in state + keep the row-ref array in the same order */
    const swapAt = (i: number, j: number) => {
      const arr = [...rowsRef.current]
      const tmp = arr[i]
      arr[i] = arr[j]
      arr[j] = tmp
      const rr = rowRefs.current
      const rt = rr[i]
      rr[i] = rr[j]
      rr[j] = rt
      rowsRef.current = arr
      setRows(arr)
    }

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      const total = rowsRef.current.length
      let idx = d.index
      let swapped = false
      const up = e.clientY - d.baseY < 0
      // allow crossing several rows in one fast event (flick), but never loop forever
      for (let guard = 0; guard < total; guard++) {
        const el = draggedElRef.current
        if (!el) break
        const rect = el.getBoundingClientRect() // includes the current transform
        const center = rect.top + rect.height / 2
        if (up) {
          if (idx <= 0) break
          const prevEl = rowRefs.current[idx - 1]
          if (!prevEl) break
          const pr = prevEl.getBoundingClientRect()
          if (center >= pr.top + pr.height / 2) break
          swapAt(idx, idx - 1)
          idx -= 1
          swapped = true
        } else {
          if (idx >= total - 1) break
          const nextEl = rowRefs.current[idx + 1]
          if (!nextEl) break
          const nr = nextEl.getBoundingClientRect()
          if (center <= nr.top + nr.height / 2) break
          swapAt(idx, idx + 1)
          idx += 1
          swapped = true
        }
      }
      if (swapped) {
        dragRef.current = { ...d, index: idx, baseY: e.clientY }
        setDragUi({ index: idx, dy: 0 }) // baseline reset — quantized steps
      } else {
        setDragUi({ index: idx, dy: e.clientY - dragRef.current!.baseY })
      }
    }

    const finish = (e: PointerEvent, canceled: boolean) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      dragRef.current = null
      draggedElRef.current = null
      setDragUi(null)
      if (canceled) return // keep the live-swapped local order, no persist
      const finalRows = rowsRef.current
      if (sigOf(finalRows) === d.startSig) return // tap without any swap
      void applyOrder(finalRows, d.startRows)
    }

    const onUp = (e: PointerEvent) => finish(e, false)
    const onCancel = (e: PointerEvent) => finish(e, true)

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [dragging, applyOrder, sigOf])

  /* ---------------- cells ---------------- */

  /** «قفل چرخه» countdown (item 2b) — minutes until the symbol unlocks */
  const renderLock = (s: SymbolEntry) => {
    if (s.status === 'running') {
      return (
        <span className="badge badge-accent" style={{ fontSize: 9, padding: '2px 6px', whiteSpace: 'nowrap' }} title="چرخه این نماد در حال اجراست">
          در اجرا
        </span>
      )
    }
    const remaining = s.lastCycleTime != null ? s.lastCycleTime + tradeWaitTime * 60_000 - now : 0
    if (s.lastCycleTime == null || remaining <= 0) {
      return (
        <span className="badge badge-success" style={{ fontSize: 9, padding: '2px 6px', whiteSpace: 'nowrap' }} title="آزاد برای انتخاب در چرخه بعد">
          آزاد
        </span>
      )
    }
    const mins = Math.ceil(remaining / 60_000)
    return (
      <span
        style={{ color: 'var(--warning)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}
        title={`${faNum(mins)} دقیقه تا آزاد شدن قفل چرخه`}
      >
        <i className="ph ph-clock" style={{ fontSize: 11 }} aria-hidden />
        {faNum(mins)}
      </span>
    )
  }

  const renderStatus = (s: SymbolEntry) => {
    const meta =
      s.status === 'waiting'
        ? { text: 'آماده', cls: 'badge-info', full: 'آماده' }
        : s.status === 'error'
          ? { text: 'خطا', cls: 'badge-danger', full: 'خطا' }
          : { text: 'در اجرا', cls: 'badge-accent', full: 'در حال اجرا' }
    return (
      <span className={`badge ${meta.cls}`} style={{ fontSize: 9, padding: '2px 6px', whiteSpace: 'nowrap' }} title={meta.full}>
        {meta.text}
      </span>
    )
  }

  const dragIndex = dragUi?.index ?? -1
  const total = rows.length

  /* ---------------- table ---------------- */

  return (
    <div className="table-scroll" style={{ maxHeight: 280 }} data-count={total}>
      <table
        className={`tb-table tb-compact${dragging ? ' tb-dragging' : ''}`}
        style={{ minWidth: '360px', tableLayout: 'fixed' }}
        aria-label="نمادها و اولویت چرخه"
      >
        <colgroup>
          {/* 5-b column plan (RTL): اولویت | نماد | وضعیت | قفل چرخه | خطا | آخرین چرخه | عملیات
              — sum 360px: fits the symbols panel card WITHOUT horizontal scroll
              at every two-column width (first track ≥400px ⇒ ~362px inner) */}
          <col style={{ width: 53 }} />
          <col style={{ width: 47 }} />
          <col style={{ width: 56 }} />
          <col style={{ width: 60 }} />
          <col style={{ width: 28 }} />
          <col style={{ width: 74 }} />
          <col style={{ width: 42 }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">اولویت</th>
            <th scope="col">نماد</th>
            <th scope="col">وضعیت</th>
            <th scope="col">قفل چرخه</th>
            <th scope="col">خطا</th>
            <th scope="col">آخرین چرخه</th>
            <th scope="col">عملیات</th>
          </tr>
        </thead>
        <tbody>
          {total === 0 ? (
            <tr className="tb-empty-row">
              <td colSpan={7}>
                <div className="empty-state" style={{ padding: 18 }}>
                  <i className="ph ph-inbox" aria-hidden />
                  نمادی اضافه نشده است
                </div>
              </td>
            </tr>
          ) : (
            rows.map((s, i) => {
              const isDragged = i === dragIndex
              return (
                <tr
                  key={s.id}
                  ref={(el) => {
                    rowRefs.current[i] = el
                  }}
                  data-sym={s.name}
                  className={isDragged ? 'tb-dragging-row' : undefined}
                  style={
                    isDragged
                      ? {
                          position: 'relative',
                          zIndex: 20,
                          opacity: 0.85,
                          transform: `translateY(${dragUi!.dy}px)`,
                          boxShadow: '0 8px 20px -6px rgba(15, 23, 42, 0.28)',
                        }
                      : undefined
                  }
                >
                  {/* اولویت — arrows (keyboard path) + badge + drag handle */}
                  <td style={{ textAlign: 'center' }}>
                    <div className="sym-prio">
                      <span className="sym-prio-btns">
                        <button
                          type="button"
                          className="sym-arrow"
                          onClick={() => moveBy(i, -1)}
                          disabled={i === 0}
                          aria-label={`انتقال ${s.name} به بالا در اولویت`}
                          title="تقدم چرخه"
                        >
                          <i className="ph ph-arrow-up" aria-hidden />
                        </button>
                        <button
                          type="button"
                          className="sym-arrow"
                          onClick={() => moveBy(i, 1)}
                          disabled={i === total - 1}
                          aria-label={`انتقال ${s.name} به پایین در اولویت`}
                          title="تقدم چرخه"
                        >
                          <i className="ph ph-arrow-down" aria-hidden />
                        </button>
                      </span>
                      <span className="sym-prio-main">
                        <span className="sym-prio-badge" title={`تقدم چرخه ${i + 1}`}>
                          {faNum(i + 1)}
                        </span>
                        <button
                          type="button"
                          className="sym-drag-handle"
                          onPointerDown={(e) => startDrag(e, i)}
                          aria-label={`جابجایی ${s.name}`}
                          title="جابجایی در اولویت (درگ)"
                        >
                          <i className="ph ph-dots-six-vertical" aria-hidden />
                        </button>
                      </span>
                    </div>
                  </td>
                  {/* نماد */}
                  <td dir="ltr">
                    <b>
                      <bdi style={{ fontSize: 11.5 }}>{s.name}</bdi>
                    </b>
                  </td>
                  {/* وضعیت */}
                  <td style={{ textAlign: 'center' }}>{renderStatus(s)}</td>
                  {/* قفل چرخه */}
                  <td style={{ textAlign: 'center' }}>{renderLock(s)}</td>
                  {/* خطا */}
                  <td dir="ltr" style={{ textAlign: 'left' }}>
                    <span className="num" style={{ color: s.errorCount > 0 ? 'var(--danger)' : 'var(--text-muted)', fontSize: 11 }}>
                      {s.errorCount}
                    </span>
                  </td>
                  {/* آخرین چرخه — two-line Jalali datetime */}
                  <td style={{ textAlign: 'left' }}>{renderCellDateTime(s.lastCycleTime)}</td>
                  {/* عملیات — حذف */}
                  <td style={{ textAlign: 'center' }}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '4px 5px' }}
                      onClick={() => onRemove(s.name)}
                      title={`حذف ${s.name}`}
                      aria-label={`حذف ${s.name}`}
                    >
                      <i className="ph ph-trash" style={{ fontSize: 13 }} aria-hidden />
                    </button>
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
