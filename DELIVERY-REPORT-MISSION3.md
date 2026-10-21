# Mission 3 — Delivery Report (TradeBot-Production-V2)

## 1. Commits
- **Base:** `66842e8` (main, pre-mission) — mission branch `mission/v2-fixes` recorded at base.
- **Final chain (main):** `7e0c5e3` → `11e2167` → `1e425a2`(server core) → `6560b4a` → `02bb8cc`(§4+§5) → `ac67e05` → `6fe1d0c`(§1+§2-UI) → `8ad7af8`(§3+§8-UI+§9+§10) → `9fec8a4`(§7).

## 2. Changed files (66842e8..9fec8a4)
`src/server/exchanges/toobit/{client,endpoints}.ts` · `src/core/{signals/status,signals/generate,settings,indicators/*,risk/controls,strategy/*,time/*,types/index}.ts` · `src/server/automation/cycle-engine.ts` · `src/server/analytics/symbol-stats.ts` (new) · `src/app/api/{positions/open,positions/close,market/analysis,market/klines,diagnostics/symbol-stats}/route.ts` · `src/modules/automation/{AutomationView,CloseConfirmDialog,SymbolStatsTable}.tsx` · `src/modules/chart/{ChartView,types,focusUrl}.ts(x)` · `src/modules/layout/Sidebar.tsx` · `src/modules/common/{format,DataTable}.ts(x)` · `src/app/{page.tsx,globals.css,layout.tsx}` · `public/fonts/*.woff2` (5, self-hosted) · tests: `{pnl-mapping,tpsl-mapping,symbol-stats,fidelity,datetime-format,close-confirm,chart-focus-url}.test.ts` · `package.json` (test chain).

## 3–4. Root-cause defects found & fixes
| # | Root cause | Fix |
|---|---|---|
| 1 | TP/SL dead path: `normalizePosition` hard-coded nulls — reference has NO read-back; Toobit hides TP/SL rows unless `type=STOP_PROFIT_LOSS` | Live-probe verified `GET openOrders?type=STOP_PROFIT_LOSS`; `buildTpslMap` joins per symbol+side; tri-state `tpslStatus` (ok/unknown) — «تنظیم نشده» vs «نامشخص» never conflated (§2.2) |
| 2 | **Engine could re-trade an already-opened signal** (no history-status gate) | New cycle step fetches userTrades → `resolveSignalStatus`; latest signal trades ONLY in PENDING; new action `SIGNAL_ALREADY_OPENED` |
| 3 | Status window + expiry measured from closeTime (ref uses candle openTime) | Both now from `candleOpenTime` (ref `signal.timestamp`) |
| 4 | Symbol-form mismatch (signal "BTC" vs fill "BTC-SWAP-USDT") — OPENED never matched | Normalized in `resolveSignalStatus` |
| 5 | `minSameDirectionCandles`: trailing-runs semantics; ref checks FIRST-N prefix incl. forming candle | Prefix semantics restored; post-signal candles now include the forming candle |
| 6 | Opposite-close failure aborted the cycle (ref: non-fatal) | Non-fatal; positions re-fetched after close attempt (ref step 11) for risk controls |
| 7 | Cycle price source = ticker (ref fetchPrice = last 1h kline close; order-qty price = ticker) | Risk/notify price = last kline close; order qty unchanged |
| 8 | Price-distance control used position avgPrice (ref: latest OPEN fill from trade history) | `ctx.lastOpenPrice` from userTrades (getLastEntryPrice parity); null ⇒ control skipped like ref |
| 9 | Close button POSTed with no confirmation | `CloseConfirmDialog` — Escape/backdrop/انصراف = zero requests (E2E-proven); confirm = exactly 1 request, disabled in flight; real result toast + re-fetch |
| 10 | PnL column inverted vs spec | Percent primary/larger, `(±X.XX USDT)` smaller muted; `— (—)` for missing |
| 11 | Time format inconsistent (no year/seconds, browser tz) | Central `fmtDateTime` — `Intl` `fa-IR-u-nu-arabext`, `calendar:'persian'`, `timeZone:'Asia/Tehran'`, seconds; stored UTC ISO untouched; all call sites migrated |
| 12 | Font = jsdelivr CDN (offline/IR fail) | 5 Vazirmatn woff2 self-hosted (400/500/600/700/800), @font-face swap; zero CDN requests (E2E-proven) |
| 13 | No signal→chart navigation | Click signal row/сhart icon → URL-restore contract `?chart=&interval=&focus=<ms>&side=`; history prefetch for old signals; marker+Entry/TP/SL lines; «بازگشت به اکنون» |
| 14 | No per-symbol stats | `/api/diagnostics/symbol-stats` — aggregate `historyPositions` (limit 200 = live cap, `truncated` surfaced), dedup by position id, winRate, after-fee netIncome; server-sorted count↓/income↓/symbol↑ |
| 15 | Log/cycle split; cycleId hidden in submenu | Unified panel: summary header + ONE table (time, symbol, process, status, details, cycleId short+copy); old split deleted; per-row funnel icon removed |
| 16 | Symbols table permanent h-scroll (minWidth 430 > 360 panel) | 1fr|2fr top grid (348px|697px @1440); symbols table fits w/o h-scroll (scrollWidth==clientWidth proven) |

## 5. V2 ↔ Reference fidelity (mission §6)
- **Indicators:** RSI formula identical to ref (Wilder + `avgLoss=0→rs=100` quirk + `rsi[period]` null); the ref's 1-candle off-by-one (repainting lookahead) is FIXED in V2 and **proven by twin test**: V2 rsi[i] ≡ ref rsi[i−1] for all i. ATR exact-equal (first-TR seed + RMA). SMA(volume) only.
- **Strategy:** Fake-breakout state machine faithful (expiry→new/replacement→recovery→consume; same-candle fake-out allowed; lifetime=lookback=50; Wick method; ATR×0.20 distance; HTF signalCandleClose). TP/SL twins: Long close±atr×{20,6}; Short close−atr×24 / **shortFixedSl=6% default quirk preserved**. End-to-end 50-candle fixtures produce exactly 1 Long / 1 Short / 0 signals with twin-equal values.
- **Divergences kept (documented):** (a) RSI index alignment (repaint fix — test-proven identity); (b) `realizedPnlRate` ×100 — live probe proves the RAW API value is a FRACTION (−0.02300216 = −2.30%), so the REFERENCE has a ×100 display bug; V2 conversion is correct. (c) explicit closed-candle check vs ref's loop bound (equivalent, no repaint).

## 6. API contracts (live-probe verified, read-only GETs)
- Positions payload fields confirmed (profitRate **fraction**, ×100 once at normalizer). NO TP/SL in positions payload.
- TP/SL read-back: `GET /api/v1/futures/openOrders?type=STOP_PROFIT_LOSS` (status ORDER_NEW; orderType STOP_{LONG|SHORT}_{PROFIT|LOSS}; stopPrice) — docs: api-docs.toobit.com; `pageSize` ignored, `limit` honored (live cap 200; docs claim 1000).
- userTrades manual unsorted query (symbol,limit,recvWindow,timestamp) works (200). historyOrders exists; v2 algo endpoints exist (unused).
- Kline intervals: 1m,3m,5m,15m,30m,1h,2h,4h,6h,8h,12h,1d,1w,1M (45m/2d/3M → −10009).

## 7–9. Test results (150 checks, 7 suites, all green)
pnl-mapping 15 · tpsl-mapping 11 · symbol-stats 24 · **fidelity 34** (twins + fixtures + gates) · datetime-format 23 (incl. ICU gate, midnight rollover ۱۴۰۵/۰۷/۲۹) · close-confirm 22 · chart-focus-url 21. E2E: close-dialog request ledger 0/0/0/0 then exactly +1 (mocked); chart focus: visibleRange 1790859600–1791291600 CONTAINS signal bar 1791147600 (≈240 bars old — history prefetch exercised), 1 marker at the bar, URL restored on reload.

## 10. Sanitized log sample (unified table)
`۱۴۰۵/۰۷/۲۹, ۱۰:۲۷:۲۵ | DOT | محاسبات و سیگنال | موفق | 2 سیگنال در تاریخچه تحلیل تولید شد | c_mvhrf6…` · `… | DOT | بررسی تازگی سیگنال | رد/ردشده | سیگنال منقضی شده است | c_mvhrf6…` — steps in execution order, secrets stripped server-side (`sanitizeStepData`).

## 11. Stats sample (real account, sanitized)
DOT 82 معامله / +2.03 · XRP 56 / −1.16 · DYDX 33 / −1.18 (+4 more symbols) — coverage note «بر اساس 200 معامله اخیر (ممکن است کامل نباشد)».

## 12. Responsiveness
1440px: panels 348.66|697.34 = 1:2 exact; no h-scroll. 768px: stacked, in-page stats. 390px: docScroll 390==winW, drawer 320px usable, real-Escape closes, sticky footer (min-height 844 + margin-top:auto).

## 13. TypeScript / Lint / Build
`tsc --noEmit` 0 errors · `eslint .` 0 errors · 7/7 suites. **Build note (deviation):** this sandbox forbids `next build` (dev-server-only constraint); full typecheck + lint + 150 runtime checks + live-server E2E stand in for the build gate; the Cloudflare Pages build path is unchanged from the prior mission.

## 14. Unresolved / incidents
1. **Incident (honest):** during §1 E2E the first network-route mock pattern missed (`/api/positions/close` vs required `**/…`) → one REAL close of XRP-SHORT on the provided test account (margin $2.16, realized −$0.11 USDT). Pattern fixed, interception proven before further tests; 2 positions remained. No other real orders were ever sent (probe = GET-only; all flows mocked).
2. Cron-secret naming mismatch (`CRON_SECRET` route vs `X_CRON_SECRET` docs vs worker `X-Cron-Secret`) — flagged, untouched (deployment config; needs owner decision).
3. `bdi` inside `<td>` rendering nuance logged by agents; harmless, tracked in worklog.
4. No CI pipeline (unchanged).

## Security
`.env` with the provided test credentials is git-ignored (verified); no secrets in any commit/fixture/log (git grep proven). **Owner action:** revoke the Toobit API key/secret and the GitHub PAT after review — they were transmitted in chat.
