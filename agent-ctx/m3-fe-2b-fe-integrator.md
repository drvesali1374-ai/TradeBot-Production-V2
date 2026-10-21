# m3-fe-2b — fe-integrator (main session)

## Task
Unified cycle+log table (§3), symbol-stats sidebar (§8-UI), desktop 1/3+2/3 top layout (§9), tables audit (§10). Server code untouched.

## Plan (before coding)
- ACTION_LABELS in AutomationView.tsx LACKS `SIGNAL_ALREADY_OPENED` (server added the CycleAction value) → add «سیگنال قبلاً باز شده» (badge-warning).
- DataTable: add `compact` prop (→ .tb-compact tighter cell padding for narrow panels), `rowClassName` hook (current-cycle row accent §3.2), fix expanded-details `colSpan` (currently columns.length, should be +1 when expandable set exists → audit §10).
- New shared `SymbolStatsTable` (DataTable-based — §10 forbids a second table impl): columns نماد|تعداد|نرخ برد|درآمد خالص; winRate fmtPct(x,0); netIncome fmtUsdtAmount+pnlColor LTR-isolated; empty→«داده‌ای موجود نیست»; success:false→«خطای دریافت آمار»; coverage note «بر اساس {basedOnCount} معامله اخیر» + «(ممکن است کامل نباشد)» when truncated. Two render contexts: sidebar (desktop) + panel in automation main column (<1024px, sidebar off-canvas).
- Data path: page.tsx fetches /api/diagnostics/symbol-stats on auth-ready + every refreshKey bump (covers after-cycle-run), passes payload to Sidebar AND AutomationView (single fetch, no dup).
- §3 unified panel: ONE panel = compact summary (action badge, startedAt/finishedAt fmtDateTime, Persian duration «۲.۳ ثانیه», symbol, step counts ok/warning/failed, per-cycle storage badge, run-cycle button, funnel→logCycle(last.cycleId)) above the unified log DataTable. DELETE the old split (cycle-status section with in-panel step list + separate logs section) — the persisted LogRecords ARE the steps (do NOT duplicate rows).
- Unified columns: زمان | نماد | فرایند | وضعیت | جزئیات | شناسه چرخه (8 chars + «…», click-to-copy, title=full). Expanded details: message, full cycleId + copy, source, step ordinal, durationMs, details KV — per-row funnel icon REMOVED (global funnel stays). «چرخه جاری» badge in expanded details for rows with cycleId === lastResult.cycleId; subtle row accent via rowClassName.
- Sort: when single cycleId filter active → sort by step ordinal then created_at; otherwise newest-first (server order).
- §9 layout: `.top-grid { grid-template-columns: minmax(300px,1fr) minmax(0,2fr) }`; stacks ≤1280 (existing content-grid breakpoint; 1281→col1=~296px… see worklog for math). Symbols table compact: short status badges, wrap-capable datetime cell, reduced col widths → no h-scroll at ≥1281. Sidebar 272→320px (--sidebar-width) to fit stats table (~280px content width).
- §10 audit fixes found while reading: DataTable expanded colSpan (above); positions symbol button lacks explicit aria-label for chart-nav; tb-empty-row fine; sticky thead present; log table minWidth 760→~640 compact.

## Status: DONE — completed by the follow-up integrator (audit → gaps fixed → verified)

### Audit result (what the timed-out run had already left on disk — all verified against this plan)
- §3 unified panel: DONE in working tree (summary chips + actions + ONE DataTable, old split fully deleted, no cycle-status/step-list refs remain).
- §8-UI SymbolStatsTable + sidebar/inpage twins + page.tsx single fetch: DONE.
- §9 .top-grid/−-1280 stack/sidebar 320px/symbols compact cols: DONE.
- §10: DataTable compact/fixed/rowClassName + colSpan fix + tooltip phantom-scroll fix: DONE. Dead CSS (.side-panel, .log-timeline, .step-*) removed with tombstone comments.
- Gates at hand-off: tsc 0, lint 0, 6/6 suites green, dev.log 200s only.

### Gaps found by the audit + fixes applied by the follow-up
1. `ACTION_LABELS.SIGNAL_ALREADY_OPENED` was `badge-info` (plan says warning — it is a trade-preventing gate like SIGNAL_EXPIRED/STALE) → `badge-warning` (AutomationView.tsx:87).
2. Phantom 7th table column: expandable tables add an auto `<col/>` for the sr-only «جزئیات» header; in `table-layout:fixed` the browser gave it ~16px stolen from the message column (measured 207px vs 223px) → `<col style={{width:0}}/>` in DataTable.tsx colgroup (re-measured: message col 223px, extra col 0px).
3. RTL page-level horizontal overflow ≤390px: the ≤1280 stacked track was bare `1fr`, so the unified table's 560px min-width raised the track's min-content to 598px → doc scrollWidth 610 > 390 (pre-existing bug, worse before: old table was 760px). Fix: `minmax(0, 1fr)` in the ≤1280 media rule → scroll now lives INSIDE `.table-scroll` (mission §1). After: docScrollW 390 == winW 390, .table-scroll 328px w/ internal h-scroll as designed.
- Turbopack gotcha: CSS chunk served stale after edit until a page request re-triggered compilation (curl-probed; resolved by touching globals.css + reload).

### E2E evidence (agent-browser, admin/admin123 already-authenticated session; NO trading actions, NO run-cycle, NO بستن clicks; network ledger: zero POSTs)
- 1440px: two panels 348.66px | 697.34px (ratio exactly 1:2); symbols .table-scroll scrollWidth 311 == clientWidth 311 (NO h-scroll); unified .table-scroll 659 == 659 (NO h-scroll); summary Jalali «۱۴۰۵/۰۷/۲۹, ۱۰:۲۷:۲۴» + «۲۶۵ms» duration; short cycleIds «c_mvhrf6…» with title=full id; status filter SKIPPED → 1 row «رد/ردشده» + «حذف فیلترها» appears; expanded row: full cycleId c_mvhrf64f_y2cxwu + «چرخه جاری» badge + copy button + منبع/مرحله/مدت اجرا/KV (settingsVersion v1, hasCredentials true) and funnelCount: 0; sidebar stats 7 real rows (DOT 82/39٪/+2.03, XRP 56, DYDX 33, TON, APT, ARB, SPCX) + coverage note «بر اساس ۲۰۰ معامله اخیر (ممکن است کامل نباشد)»; .stats-inpage display:none on desktop.
- 768px: stacked (732px track), .stats-inpage visible with same 7 rows, sidebar off-canvas (translateX(320px)).
- 390px: docScrollW 390 == winW (no page overflow); drawer opens (x:70, w:320, backdrop+body lock), stats usable inside (scrollWidth 287 == clientWidth 287, 7 rows, note); real Escape keypress closes it (synthetic document.dispatchEvent doesn't reach the window listener — headless quirk); footer: main-content min-height 844px + .app-footer margin-top:auto, docH 3347 (footer pushed naturally, no overlay).
- Copy button click in headless → graceful «کپی ناموفق» info toast with the id (headless denies clipboard; execCommand fallback wired — real browsers OK).
- Screenshots: /tmp/m3fe2b-1440.png, /tmp/m3fe2b-768.png, /tmp/m3fe2b-390.png, /tmp/m3fe2b-390-drawer.png — VLM-verified (two panels, no overlap/garble, stats in sidebar/main/drawer).
- No network routes were added (request ledger grep: 0 close/run-cycle/symbols requests).

### Final gates
`npx tsc --noEmit` → 0 · `bun run lint` → 0 · `bun run test` → 6/6 suites green (pnl, tpsl 11, symbol-stats 24, fidelity 34, datetime 23, close-confirm 22) · dev.log clean (200s only, no hydration). Committed on main with "m3-fe-2b".
