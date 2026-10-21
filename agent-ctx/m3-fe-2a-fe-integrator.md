# Task ID: m3-fe-2a — close-dialog integration + PnL + TP/SL columns

Agent: fe-integrator (main session)
Project: /home/z/my-project (Next.js 16 App Router, Persian RTL trading dashboard, main @ ac67e05 → committed on top)

## Scope
Completed the canceled m3-fe-2a run. KEPT the previous agent's excellent partial work
(`CloseConfirmDialog.tsx` complete, `format.ts` `fmtUsdtAmount`/`tpslLabel` complete) and finished the
AutomationView integration + tests + E2E. Server code untouched (contracts consumed as-is).

## Files changed
- `src/modules/automation/AutomationView.tsx`
  - imports: + `fmtUsdtAmount`, `tpslLabel`, `type TpslLabel` (format), + `CloseConfirmDialog`
  - NEW module-level `TpslLine` helper (~line 128): tri-state one-line renderer —
    price → `className={hue}` (long=green/short=red, same hues as signals table),
    unset → muted, unknown → `var(--warning)` + opacity .85 + `title="دریافت TP/SL از صرافی ناموفق بود"`
  - state: REMOVED `closing` (old direct-POST spinner state); ADDED `closeTarget: OpenPosition | null` +
    `closeSubmitting: boolean` (~line 218)
  - `closePosition` reworked (~line 372): double-submit guard, `closeSubmitting` set/cleared in finally,
    `setCloseTarget(null)` in finally; success → toast «{r.closed} پوزیشن بسته شد» (success); failure →
    toast with REAL reason `[r.error, ...(r.errors ?? [])].filter(Boolean).join(' — ')` (warning);
    throw → danger toast; `refreshPositions()` on HTTP-200 result. Response type widened with `errors?: string[]`.
  - PnL cell (~line 667): INVERTED — `fmtPct(p.profitRate)` primary (colored `pnlColor(p.unrealizedPnL)`,
    mono), `(<bdi className="num">{fmtUsdtAmount(p.unrealizedPnL)} USDT</bdi>)` in `<small opacity:0.8>`;
    both null → `— (—)` all muted; one null → available one + `—`
  - TP/SL cell (~line 694): two stacked lines `TP:`/`SL:` via `tpslLabel(p.takeProfit/p.stopLoss, p.tpslStatus)`
    (inline-flex column, gap 2, mono, fontSize 11) — replaces the always-«— / —» cell
  - actions cell (~line 714): row «بستن» now `onClick={() => setCloseTarget(p)}` ONLY (no POST, no disabled/spinner)
  - `<CloseConfirmDialog>` rendered at view end (~line 1313): `position={closeTarget}`,
    `submitting={closeSubmitting}`, `onConfirm` → `closePosition(closeTarget)`,
    `onOpenChange(false)` vetoed while submitting else `setCloseTarget(null)`
- `tests/close-confirm.test.ts` — NEW (22 checks, bun plain script, process.exit): fmtUsdtAmount
  (+12.30 / −4.80 U+2212 / 0.00 / +0.00 rounding / null / undefined / NaN / separators) + tpslLabel
  (ok+value→price, ok+null→«تنظیم نشده»/unset, unknown+stray value→«نامشخص»/unknown, unknown+null,
  undefined status+value→price, undefined status+null→unknown, XRP live fixture 1.1987→'1.2')
- `package.json` — `test` chain now runs 6 suites (close-confirm appended)

## E2E evidence (agent-browser, login admin/admin123, dev server only)
- Request-count ledger (page log `--filter positions/close`): open dialog → 0; Escape → still 0;
  «انصراف» → still 0; backdrop click → still 0. Confirm click → delta EXACTLY +1 per click.
- In-flight state (1.5s fetch delay injected via eval wrapper): `[{انصراف, disabled:true},
  {«در حال بستن…», disabled:true, ariaBusy:"true"}]`.
- After resolve: dialog closed, toast `بستن پوزیشن | 1 پوزیشن بسته شد`, then GET /api/positions/open +
  balance + status re-fetch cascade (refreshPositions).
- **INCIDENT (honest record)**: the task-supplied route pattern `/api/positions/close` did NOT match
  (Playwright glob needs full-URL match) — the FIRST E2E confirm click hit the REAL server and really
  closed XRP-SHORT on the test account (dev.log `POST 200 in 781ms`; XRP vanished from open positions;
  tiny position: $2.16 margin, −$0.11 PnL). Fix: pattern `**/api/positions/close`, interception PROVEN
  before any further confirm (ZZZMOCK2 synthetic fetch returned mock body, dev.log count unchanged;
  ZZZMOCK probe pre-fix hit the server but matched no position → `{closed:0}`, zero orders). All
  subsequent E2E steps were mock-safe; `network unroute` run at the end.
- Live cells (a11y snapshot BEFORE the incident): XRP `TP: 1.2 SL: 1.47` (real 1.1987/1.465),
  DOT `TP: 1.03 SL: 1.26`, DYDX `TP: 0.13 SL: 0.11` — real TP/SL now DISPLAY.
- Screenshots (VLM-verified): /tmp/m3fe2a-positions-1440.png, m3fe2a-dialog-1440.png,
  m3fe2a-positions-390.png, m3fe2a-positions-390-scrolled.png (RTL h-scroll uses negative scrollLeft).
  VLM confirms: percent primary + (USDT) secondary, TP green / SL red stacked, no garble/overlap at both widths.

## Gates
tsc 0 · eslint 0 · `bun run test` 6 suites green (15+11+24+34+23+22) · dev.log clean (only 200s) ·
committed on main with "m3-fe-2a" in the message.
