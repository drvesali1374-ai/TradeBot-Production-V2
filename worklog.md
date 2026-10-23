# Worklog — TradeBot New Version (Redesign)

Project: بازطراحی کامل TradeBot-Production طبق دستورالعمل «Trade Bot New Version.txt» با تم جدید dashboard.html

## Reference Sources
- Repo: /tmp/tradebot-ref (clone of https://github.com/drvesali1374-ai/TradeBot-Production)
- Instructions: /tmp/trade-bot-instructions.txt
- Theme: /tmp/dashboard-theme.html

## Key Facts (Read so far)
- Old project: Next.js 16 + static HTML pages in public/ + edge API routes + Cloudflare KV (TRADING_DATA) + cron worker every 5 min
- Strategy: Fake Breakout on 1h candles, RSI/ATR/SMA indicators, daily levels, 6 risk controls, Bale notifications
- Theme: RTL Persian, Vazirmatn font, Phosphor icons, indigo/violet accent (#6366f1 → #a855f7), glassmorphism, light/dark
- Toobit public endpoints guessed wrong (404) — must extract exact endpoints from reference code

---

Task ID: audit-1
Date: 2026-02-27 (session)
Scope: RESEARCH-ONLY deep audit of server cycle engine + related API routes in /tmp/tradebot-ref. No code written.

# Audit Report — Server Cycle Engine & Infrastructure (TradeBot-Production)

## A. Cycle Engine (`src/lib/tradebot/cycle-engine.ts`, 2172 lines)

### A.0 File facts & design rules
- TypeScript port of client-side `AutomationManager.runCycle()` (public/js/automation-manager.js) so a full cycle runs server-side (manual /api/run-cycle OR cron worker every 5 min).
- Imports: `import { AutomationState, initializeDatabase } from '@/lib/tradebot/database'` (that's `src/lib/tradebot/database.js` — KV-backed, JSON-file fallback for local dev).
- CRITICAL design rules (header comment): logic MUST exactly mirror client runCycle(); do NOT "improve"; ALL settings read from permanent DB (AutomationState/KV), NOT localStorage; indicator math copied verbatim from signal-utils.js / analyzeMarketData(); risk controls use same formulas & same Bale notifications.
- Exported functions: `runCycle(baseUrl, options)` and `checkClosedPositionsHistory(baseUrl)`.

### A.1 Step list (exact order, ~14 steps as in header comment + actual code placement)
Header comment lists the classic 14 steps; actual code adds step 9/10 refreshes and the مورد ۶ control:

| # | Step (client fn name) | Server implementation |
|---|---|---|
| 0 | (load settings/symbols) | `AutomationState.get('automation_settings')`, `.get('marketSignalSettings')`, `.get('automation_symbols')` from KV |
| 1 | `selectNextSymbol()` | pick first ready symbol (tradeWaitTime gating) |
| 2 | `setupForCycle()` | per-cycle state cleared; **immediate KV persist of `lastCycleTime`** for chosen symbol |
| 3 | `fetchMarketData()` | GET `/api/toobit-proxy?symbol={X}-SWAP-USDT&interval={i}&limit={l}` |
| 4 | `analyzeMarketData()` | full signal generation (RSI/ATR/SMA/daily levels/fake breakout) |
| 5 | `fetchPositionHistory()` | POST `/api/history` `{symbol, apiKey, secretKey, baseUrl, limit: 100}` |
| 6 | `updateSelectedSignal()` | only latest signal with status "در انتظار" (expiration-aware) |
| 7 | `fetchPrice()` | GET `/api/toobit-proxy?...&interval=1h&limit=1`; price = `parseFloat(klines[0][4])` |
| 8 | `closeOppositePositions()` | close opposite-direction open position first |
| 8.5 | مورد ۶: Min Same-Direction Candles control | placed AFTER step 8, BEFORE step 9 |
| 9 | (NEW) refresh position-history table | re-POST `/api/history` (reflects just-closed opposite positions) |
| 10 | (NEW) refresh open-positions table | GET `/api/open-positions` → `freshOpenPositions`; compute "آخرین ورود" (`symbolLastEntryPrice`) from fresh history; replaces old `getSymbolMargin()` |
| 11 | `fetchBalance()` | GET `/api/balance` (headers X-API-Key/X-Secret-Key/X-Base-Url) |
| 12 | `calculateNewMargin()` + 6 risk controls | margin = totalAssets × entryMarginPercent% (direction-specific) |
| 13 | `openPosition()` | POST `/api/create-position` |
| 14 | `notifyOpenPosition()` | POST `/api/bale-send` (with KV pending-queue fallback) |

After every terminal path the symbol's status flips back to `'waiting'` (in-memory). `lastCycleTime` was already persisted at step 2. The catch block does its own read-modify-write of `automation_symbols` to bump `errorCount` (allowedErrors tracking).

### A.2 `runCycle()` signature & logging
```ts
runCycle(baseUrl: string, options?: {
  symbolOverride?: string | null
  triggerSource?: 'manual' | 'cron'
}): Promise<CycleResult>
```
- `logs: CycleLogEntry[]` collected in memory; `log(message, type = 'info', symbol?)` pushes `{message, type, symbol, timestamp: new Date().toISOString()}` into `logs` AND into `pendingDbLogs` buffer (with `source: triggerSource || 'server'`), plus `console.log('[CycleEngine:{source}] {TYPE} [{symbol}] {message}')`.
- `flushLogs()` is a **no-op** ("Transaction Buffer" پیشنهاد ۱): logs are returned in `CycleResult.logs` and `/api/run-cycle` writes them to KV ONCE after all cycles.

### A.3 Settings — `AutomationSettings` interface + DEFAULTS (`getDefaultAutomationSettings()`)

| Key | Type | Default | Purpose |
|---|---|---|---|
| safeAssetPercent | number | **50** | % of total assets kept safe |
| entryMarginPercent | number | **5** | % of total assets used as margin per entry |
| maxMarginPerSymbolPercent | number | **10** | max total margin per symbol (% of assets) |
| minPriceDistancePercent | number | **0.5** | min price distance from last same-direction entry (%) |
| tradeWaitTime | number | **60** | minutes a symbol must wait between cycles |
| allowedErrors | number | **3** | errors before symbol skip+reset |
| leverage | number | **4** | order leverage |
| signalExpirationHours | number | **6** | signal expiry (hours) |
| minSameDirectionCandles | number | **0** | مورد ۶: N same-direction candles after signal (0=off) |
| closedPositionsNotifyCount | number | **10** | مورد ۸: records per closed-positions notification |
| enableMeaningfulBreakFilter | boolean | **true** | fake-breakout meaningful-break filter |
| breakAtrMultiplier | number | **0.20** | ATR multiplier for meaningful break (legacy) |
| breakDetectionMethod | 'Wick' \| 'Close' | **'Wick'** | wick vs close based break detection |
| enableBreakLifecycleManagement | boolean | **true** | break→recovery state machine |
| breakSequenceLifetime | number | **0** | candles before break expires (0 → use `lookback`, default 50) |
| rsiLongThreshold | number? | **30** | Phase 17 independent Long RSI |
| rsiShortThreshold | number? | **70** | Phase 17 independent Short RSI |
| volMultLong | number? | **0.2** | volume multiplier Long |
| volMultShort | number? | **0.2** | volume multiplier Short |
| breakAtrMultiplierLong | number? | **0.20** | break ATR mult Long |
| breakAtrMultiplierShort | number? | **0.20** | break ATR mult Short |
| leverageLong | number? | **4** | leverage for Long |
| leverageShort | number? | **4** | leverage for Short |
| entryMarginPercentLong | number? | **5** | entry margin % Long |
| entryMarginPercentShort | number? | **5** | entry margin % Short |
| minPriceDistancePercentLong | number? | **0.5** | min price distance % Long |
| minPriceDistancePercentShort | number? | **0.5** | min price distance % Short |
| baleToken | string | **''** | Bale bot token |
| baleChatId | string | **''** | Bale chat id |

- Load: `{...getDefaultAutomationSettings(), ...(JSON.parse(db) or dbObj)}` — DB overrides defaults.
- Note: `cyclesPerRun` (مورد ۷) is read ONLY by /api/run-cycle from `automation_settings` (default 1, capped at 10) — NOT part of this interface/defaults.

### A.4 `MarketSignalSettings` (read from KV key `marketSignalSettings`)
Interface keys: `symbolName?, interval?, limit?, lookback?, volMult?, avgVolPeriod?, rsiThreshold?, rsiPeriod?, atrPeriod?, tpLongMult?, slLongMult?, tpShortMult?, slShortMult?, longFixedTp/Sl?, shortFixedTp/Sl? (number|null), htfConfirmationSource?, apiKey?, secretKey?, baseUrl?`
Defaults from `public/init-settings.js` `defaultSettings`:

| Key | Default |
|---|---|
| symbolName | 'DOT' |
| interval | '1h' |
| limit | 1000 |
| lookback | 50 |
| volMult | 0.2 |
| avgVolPeriod | 50 |
| rsiThreshold | 50 |
| rsiPeriod | 14 |
| atrPeriod | 14 |
| tpLongMult | 20 |
| slLongMult | 6 |
| tpShortMult | 24 |
| slShortMult | 4 |
| longFixedTp / longFixedSl | null / null |
| shortFixedTp / shortFixedSl | null / 6 |
| htfConfirmationSource | 'signalCandleClose' |
| apiKey / secretKey | '' / '' |
| baseUrl | 'https://api.toobit.com' |

Engine inline fallbacks: `interval||'1h'`, `limit||1000`, `atrPeriod||14`, `avgVolPeriod||50`, `rsiPeriod||14`, `lookback||50`; `rsiLongThreshold ?? marketSettings.rsiThreshold ?? 30`, `rsiShortThreshold ?? marketSettings.rsiThreshold ?? 70` (note: marketSettings.rsiThreshold default in UI is 50, but engine's ?? chain only hits 30/70 when threshold is undefined), `volMultLong/Short ?? marketSettings.volMult ?? 0.2`, `tpLongMult||20`, `slLongMult||6`, `tpShortMult||24`, `slShortMult||4`, `htfConfirmationSource||'signalCandleClose'`, `baseUrl||'https://api.toobit.com'`.

### A.5 Types (exported)
- `SymbolEntry { id: number; name: string; status: 'waiting'|'running'|'error'; errorCount: number; lastCycleTime: number | null }`
- `Candle { timestamp: Date; open, high, low, close, amount: number; rsi?, atr? (number|null); signal? ('Long'|'Short'|null); tp?, sl? (number|null); clientOrderId? (string|null) }`
- `Signal { type: 'Long'|'Short'; timestamp: Date; price: number; tp: number; sl: number; orderId: string; symbol: string; candleIndex?: number }`
- `HistoryEntry { time: Date; symbol: string; price: number; qty: number; commission: number; side: string; realizedPnl: number }`
- `BalanceInfo { asset: string; total, available, free, positionMargin, orderMargin, unrealizedPnL: string (4-dp); fetchedAt: string }`
- `CycleLogEntry { message; type: 'info'|'success'|'warning'|'error'; symbol?; timestamp: string }`
- `CycleResult { success: boolean; symbol: string|null; action: 'position_opened'|'no_signal'|'no_ready_symbol'|'risk_blocked'|'error'|'skipped'; logs: CycleLogEntry[]; errorCount: number; duration: number; symbols?: SymbolEntry[] }`

### A.6 Step 1 — `selectNextSymbol()` (symbol selection)
```ts
const now = Date.now()
const waitTimeMs = automationSettings.tradeWaitTime * 60 * 1000  // tradeWaitTime in MINUTES
const readySymbols = symbols.filter(s => !s.lastCycleTime || (now - s.lastCycleTime >= waitTimeMs))
let symbol = options.symbolOverride
  ? symbols.find(s => s.name === options.symbolOverride) || null   // override ignores wait time
  : (readySymbols.length > 0 ? readySymbols[0] : null)            // FIRST ready in list order
```
- Empty symbols list → warning log `هیچ نمادی در لیست اتوماسیون وجود ندارد`, return `{success:false, action:'no_ready_symbol', errorCount:0}`.
- No ready symbol → warning `هیچ نمادی برای معامله آماده نیست`, same no_ready_symbol return.
- Log: `شروع چرخه برای نماد {name}`.
- **allowedErrors** is NOT used in selection — it's only used in the catch block: when a cycle throws, errorCount++ via KV read-modify-write; if `errorCount >= allowedErrors` → reset errorCount=0, status='waiting', lastCycleTime=Date.now() (symbol skipped, notification `#عبور_نماد`), else status='error' (notification `#خطا`).
- After selection: `updateSymbolState`/`updateSymbolStateInMemory` are BOTH in-memory-only helpers now (Transaction Buffer); but immediately after selection there IS one real KV write: `symbols[idx] = {..., lastCycleTime: Date.now()}; await AutomationState.set('automation_symbols', symbols)` (with try/catch fallback to in-memory). Rationale: next cron (5 min later) must re-read updated lastCycleTime so it doesn't re-select the same symbol.

### A.7 Step 3 — fetchMarketData
- `fullSymbol = ${symbol.name}-SWAP-USDT`
- GET `${baseUrl}/api/toobit-proxy?symbol={enc(fullSymbol)}&interval={enc(interval)}&limit={enc(limit)}`
- `!response.ok` → throw `Failed to fetch market data: HTTP {status}`
- Body must be `Array.isArray(rawData) && length>0 && Array.isArray(rawData[0])` else throw `داده‌های بازار معتبر نیست`
- Log success: `{name}: {N} کندل دریافت شد`

### A.8 Step 4 — analyzeMarketData (signal generation, verbatim port)
- Candle mapping: `timestamp = new Date(c[0])`, `open/high/low/close = parseFloat(c[1..4])`, `amount = parseFloat(c[5])`.
- **Daily levels with Tehran offset**: `offset = 3.5*3600*1000`; `day = Math.floor((ts + offset)/86400000)`; `dailyData[day] = {maxHigh, minLow, lastClose, lastTs}`. Per-candle arrays `prevDailyHighs[i]`, `prevDailyLows[i]`, `prevDayCloses[i]` (null for first day).
- Indicators:
  - `ATR(period=atrPeriod||14)`: TR = max(high-low, |high-prevClose|, |low-prevClose|); `atr[0]=TR[0]`; `atr[i] = ((period-1)*atr[i-1] + TR[i]) / period`.
  - `avgVols = SMA(amount, avgVolPeriod||50)` — plain rolling mean, null before period-1.
  - `RSI(period=rsiPeriod||14)`: first `period` values null; seed avgGain/avgLoss = sum/period; Wilder smoothing `avgGain = (avgGain*(p-1)+gain)/p`; `rs = avgLoss===0 ? 100 : avgGain/avgLoss`; `rsi = 100 - 100/(1+rs)`.
- Crossover trackers (legacy path): `lastCrossUnderPL` / `lastCrossOverPH` = bars since close crossed under prev-day Low / over prev-day High (Infinity if never).
- **Meaningful break trackers** (filter enabled by default): `bdLong = atr[i]*breakAtrMultiplierLong`, `bdShort = atr[i]*breakAtrMultiplierShort`; Wick method: `mbl = prevDailyLows[i] !== null && data[i].low <= prevDailyLows[i] - bdLong`; `mbs = high >= prevDailyHighs[i] + bdShort`; Close method uses `close` instead of low/high. Track `lastMeaningfulBreakLong/Short[i] = i - lastIdx` (Infinity if none).
- **HTF confirmation** (`htfSource = marketSettings.htfConfirmationSource || 'signalCandleClose'`):
  - `'previousDayClose'`: htfConfirmLong = `prevDayCloses[i] !== null && prevDayCloses[i] > prevDailyLows[i]`; htfConfirmShort = `prevDayCloses[i] !== null && prevDayCloses[i] < prevDailyHighs[i]`.
  - default (`'signalCandleClose'`): htfConfirmLong = `prevDailyLows[i] !== null && data[i].close > prevDailyLows[i]`; htfConfirmShort = `prevDailyHighs[i] !== null && data[i].close < prevDailyHighs[i]`.
- Loop `for (i = 1; i < N-1; i++)` (last candle excluded — needs a completed candle):
  - **Branch A (default, `enableBreakLifecycleManagement !== false`) — Break Lifecycle state machine**:
    - `BreakState { active, type:'Long'|'Short'|null, breakCandleIndex, waitingRecovery, recovered, recoveryCandleIndex }`, `resetBreakState()` all-zero.
    - 1) Expiry: `lifetime = breakSequenceLifetime > 0 ? breakSequenceLifetime : (marketSettings.lookback || 50)`; if `i - breakCandleIndex > lifetime` → reset.
    - 2) New meaningful break (if `!active || recovered`): Long break (low/close <= prevLow − bdLong) → state Long/waitingRecovery; else Short break (high/close >= prevHigh + bdShort) → state Short.
    - 3) Opposite break while waiting → replace state with the new direction.
    - 4) Recovery: Long → `close > prevDailyLow`; Short → `close < prevDailyHigh` → set `recovered=true, recoveryCandleIndex=i, waitingRecovery=false`.
    - 5) Signal ONLY on the recovery candle (`recovered && recoveryCandleIndex === i`):
      - `condLong = avgVols[i] !== null && amount > avgVols[i] * (volMultLong ?? marketSettings.volMult ?? 0.2) && rsi[i] !== null && rsi[i] < (rsiLongThreshold ?? marketSettings.rsiThreshold ?? 30) && htfConfirmLong`
      - `condShort = avgVols[i] !== null && amount > avgVols[i] * (volMultShort ?? marketSettings.volMult ?? 0.2) && rsi[i] !== null && rsi[i] > (rsiShortThreshold ?? marketSettings.rsiThreshold ?? 70) && htfConfirmShort`
      - TP/SL (Long): `longFixedTp` (non-null, non-NaN) → `tp = close + close*(longFixedTp/100)` else `tp = close + atr[i]*(tpLongMult||20)`; `longFixedSl` → `sl = close - close*(longFixedSl/100)` else `sl = close - atr[i]*(slLongMult||6)`.
      - TP/SL (Short): `shortFixedTp` → `tp = close - close*(shortFixedTp/100)` else `tp = close - atr[i]*(tpShortMult||24)`; `shortFixedSl` → `sl = close + close*(shortFixedSl/100)` else `sl = close + atr[i]*(slShortMult||4)`.
      - `clientOrderId = generateOrderId(timestamp, symbolName)` = `{SYMBOL}_{YYYYMMDD}_{HHMMSS}`.
      - Push `Signal{type, timestamp, price: close, tp, sl, orderId, symbol, candleIndex: i}`; set `data[i].signal/tp/sl/clientOrderId`.
      - Reset break state (break consumed whether or not signal fired).
  - **Branch B (legacy, `enableBreakLifecycleManagement === false`)**:
    - `isCrossOverPL = close > prevLow && prevClose <= prevLow(prev i-1)`; `isCrossUnderPH = close < prevHigh && prevClose >= prevHigh(prev)`.
    - `recentBreakLong = enableMeaningfulBreakFilter ? lastMeaningfulBreakLong[i] : lastCrossUnderPL[i]`; `recentBreakShort = ... lastMeaningfulBreakShort/lastCrossOverPH`.
    - `condLong = isCrossOverPL && recentBreakLong <= (lookback||50) && <vol filter> && <RSI < 30-ish> && htfConfirmLong`; `condShort` mirrored.
    - Same TP/SL/orderId/signal emission as branch A.

### A.9 Step 5 — fetchPositionHistory
- Only if `apiKey && secretKey` (from marketSettings). POST `/api/history` body `{symbol: fullSymbol, apiKey, secretKey, baseUrl: toobitBaseUrl, limit: 100}`.
- Response normalization: `Array | data[] | result[] | first array value in object`.
- Map to HistoryEntry: `time = new Date(parseInt(item.time||0))`, `symbol = String(item.symbol||'-')`, `price/qty/commission/realizedPnl = parseFloat(String(...||0))`, `side = String(item.side||'-')`.
- Errors → warning log `{name}: خطا در دریافت تاریخچه - {msg}` (non-fatal). Log count `{name}: {n} معامله یافت شد`.
- (Toobit endpoint behind it: `GET /api/v1/futures/userTrades?symbol=...&limit=...&recvWindow=5000&timestamp=...&signature=...` header `X-BB-APIKEY`.)

### A.10 Step 6 — updateSelectedSignal & expiration (exact statuses)
- `isSignalExpired(signal)`: `(now - signalTime) > (signalExpirationHours || 6) * 60*60*1000`.
- `calculateSignalStatus(signal) -> {text}`:
  - `signalDirection = type === 'Long' ? 'BUY' : 'SELL'`
  - `openPositions = currentSymbolHistory.filter(pos => pos.side.includes('OPEN') && pos.side.includes(signalDirection))`
  - window = `[signal.timestamp, nextSignal.timestamp)` (Infinity for last)
  - `matchingPositions = openPositions.filter(pos => posTime >= currentTime && posTime < nextTime)`
  - if `matchingPositions.length > 0` → `'باز شده'` (opened)
  - else if latest && isSignalExpired → `'منقضی شده'` (expired)
  - else if latest → `'در انتظار'` (pending — the ONLY tradeable status)
  - else → `'باز نشده'` (not opened)
  - (If no history array at all: same latest/expired logic without matching.)
- `latestSignal = signals[signals.length - 1]`; `selectedSignal = status.text === 'در انتظار' ? latestSignal : null`.
- Rejections return `action: 'no_signal'` (status 'waiting'):
  - expired → log `{name}: سیگنال منقضی شده است (بیش از {H} ساعت از صدور گذشته) - از این نماد عبور میشود`
  - other → `{name}: هیچ سیگنالی برای ورود آماده نیست - از این نماد عبو میشود` (note the typo "عبو" is verbatim in source)
- If signals.length === 0 → `{name}: هیچ سیگنالی یافت نشد - شرایط بازار مناسب نیست`, no_signal.
- Success log: `{name}: سیگنال آماده ورود - {Long|Short}`.
- **Phase 17 effective (direction-specific) params** computed right after selection:
  - `effLeverage = isLong ? (leverageLong ?? leverage) : (leverageShort ?? leverage)`
  - `effEntryMarginPercent = isLong ? (entryMarginPercentLong ?? entryMarginPercent) : (entryMarginPercentShort ?? entryMarginPercent)`
  - `effMinPriceDistancePercent = isLong ? (minPriceDistancePercentLong ?? minPriceDistancePercent) : (minPriceDistancePercentShort ?? minPriceDistancePercent)`

### A.11 Step 7 — fetchPrice
GET `/api/toobit-proxy?symbol={fullSymbol}&interval=1h&limit=1`; `price = parseFloat(klines[0][4])`; failures throw `'Failed to fetch price'` / `'No price data received'`. Log `قیمت فعلی = {price}`.

### A.12 Step 8 — closeOppositePositions
1. GET `/api/open-positions` with headers `{ 'X-API-Key': apiKey, 'X-Secret-Key': secretKey, 'X-Base-Url': toobitBaseUrl }`.
2. `allPositions = posResult.positions || posResult.data || []`.
3. `oppositeDirection = selectedSignal.type === 'Long' ? 'short' : 'long'`; find position where `posSymbol === fullSymbol.toUpperCase() && side === oppositeDirection.toUpperCase() && available > 0` (available = `parseFloat(pos.available || pos.position || 0)`).
4. If found, capture `closedPositionInfo { symbol, side, leverage: parseInt(pos.leverage||1), margin: parseFloat(pos.margin||0), unrealizedPnL: parseFloat(pos.unrealizedPnL||0), profitRate: parseFloat(pos.profitRate||0) * 100, avgPrice: parseFloat(pos.avgPrice||0), available }` — used later in the Bale notification.
5. POST `/api/close-position` body `{ symbol: symbol.name, direction: oppositeDir, clientOrderId: ${symbol.name}_close_${Date.now()}, settings: { apiKey, secretKey, baseUrl } }` → `closedCount = closeData.closed || 0`.
6. Errors → warning `{name}: خطا در بستن پوزیشن مخالف - {msg}` (non-fatal).
Logs: `{n} پوزیشن مخالف بسته شد` (success) or `پوزیشن مخالفی یافت نشد` (info).
Behind the scenes /api/close-position: signed GET `/api/v1/futures/positions` (no symbol filter) → filter `symbol===fullSymbol && side===('LONG'|'SHORT') && available>0`; per position POST `/api/v1/futures/order` with `side = LONG→'SELL_CLOSE' : 'BUY_CLOSE'`, `type:'LIMIT'`, `priceType:'MARKET'`, `quantity = Math.ceil(available)`, `newClientOrderId = clientOrderId || close_{ts}_{i}`; 300ms delay if multiple; response `{ success: closedCount>0, closed, total, errors? }`; `{success:false, error:'No open positions found', closed:0, total:0}` when none.

### A.13 Step 8.5 — مورد ۶: Min Same-Direction Candles control
- Skipped when `minSameDirectionCandles === 0` (default). Runs only when a signal IS selected.
- `sigIdx = selectedSignal.candleIndex`; `candlesAfterSignal = data.length - sigIdx - 1`.
- **Not enough candles** (`candlesAfterSignal < minSameDir`) → REJECT (`action:'risk_blocked'`, status 'waiting'), notify with math block:
```
سیگنال روی کندل {sigIdx} صادر شده
حداقل کندل هم‌جهت مورد نیاز = {minSameDir}
کندل‌های موجود بعد از سیگنال: {candlesAfterSignal} (کندل {checkedList})
نتیجه: تعداد کندل کافی نیست — صبر کنید تا کندل‌های بیشتری تشکیل شوند
```
- **Check each candle k = 1..minSameDir** (`ci = sigIdx + k`): Long needs GREEN (`close > open`) — line `کندل {ci}: سبز (close > open) ✓`, failure `کندل {ci}: قرمز (close < open) ✗ — کندل مخالف سیگنال لانگ`; Short needs RED (`close < open`) — mirrored text. Any opposite candle → REJECT with math:
```
سیگنال روی کندل {sigIdx} صادر شده
حداقل کندل هم‌جهت مورد نیاز = {minSameDir}
کندل‌های بررسی شده: {idx list joined with '، '}
{candleLines joined with \n}
نتیجه: شرایط برقرار نیست — پوزیشن باز نشد
```
- Pass log: `{name}: {minSameDir} کندل هم‌جهت تأیید شد (کندل‌های {list})`.
- Control name in notification: `حداقل کندل هم‌جهت (Min Same-Direction Candles)` → hashtag `#کندل_هم‌جهت`.

### A.14 Step 9 (NEW) — refresh position history
Re-POST `/api/history` (same params as step 5) into `currentSymbolHistory` so history reflects just-closed positions; log `بروزرسانی جدول سوابق پوزیشن‌ها...` / `جدول سوابق پوزیشن‌ها بروزرسانی شد ({n} ردیف)`. Non-fatal on error.

### A.15 Step 10 (NEW) — refresh open positions + "آخرین ورود"
- GET `/api/open-positions` (same headers) → `freshOpenPositions = opData.positions || opData.data || []`.
- `symbolLastEntryPrice` (last same-direction entry price) from sorted history: sort ascending by time; scan backwards for the latest row where `side.includes(sidePrefix) && side.includes('OPEN')` (sidePrefix = 'BUY' for Long, 'SELL' for Short) → its `price`, else null.
- Log `بروزرسانی جدول پوزیشن‌های باز...` / `جدول پوزیشن‌های باز بروزرسانی شد ({n} پوزیشن)`. Non-fatal.

### A.16 Step 11 — fetchBalance + balance structure
- GET `/api/balance` with X-API-Key/X-Secret-Key/X-Base-Url headers; `balance = balanceData.balance || balanceData`; throw `'Failed to fetch balance'` on !ok; throw `'API credentials not configured'` if no keys.
- `totalAssets = parseFloat(balance.total)`; `freeBalance = parseFloat(balance.free)`.
- (Behind /api/balance: signed GET `${baseUrl}/api/v1/futures/balance?{qs}&signature=`; header `X-BB-APIKEY`; normalizes array/data/result/balances/single-object; finds USDT by `asset||coin||currency||symbol`; `total = balance||total`, `available = availableBalance||available||free`, `positionMargin = positionMargin||position_margin`, `orderMargin = orderMargin||order_margin||frozen`, `unrealizedPnL = crossUnRealizedPnl||unrealizedPnl||unrealized`; **`free = available - orderMargin`**; returns `{success, balance: {asset, total, available, free, positionMargin, orderMargin, unrealizedPnL — all .toFixed(4) strings, fetchedAt}}`.)
- Log: `کل دارایی = {totalAssets} USDT, آزاد = {freeBalance} USDT`.

### A.17 Step 12 — calculateNewMargin + margin formulas
- `newMargin = parseFloat((totalAssets * (effEntryMarginPercent / 100)).toFixed(2))`
- `finalMargin = Math.max(newMargin, 0)` (Control 5).
- (Old `getSymbolMargin()` replaced by step 10's freshOpenPositions: existing same-symbol margin now read from `symbolPosition.margin`.)

### A.18 The 6 risk controls (order, formulas, messages)
PROJECT_INDEX ordering: ۱ دارایی امن, ۲ فاصله قیمت, ۳ سقف مارجین نماد, ۴ مارجین مثبت, ۵ حداقل کندل هم‌جهت, ۶ انقضای سیگنال. Engine execution order: min-candles (after step 8) → safe asset → price distance + max margin (conditional) → positive margin; expiration is in step 6.

**Control 6 — Signal expiration (مورد ۴)**: in updateSelectedSignal (A.10). Status `'منقضی شده'` when `(now - signalTime) > signalExpirationHours*3600e3`.

**Control — Min Same-Direction Candles (مورد ۶)**: see A.13. Hashtag `#کندل_هم‌جهت`.

**Control 1 — Safe Asset (دارایی امن) — ALWAYS runs**:
- `safeAmount = totalAssets * (safeAssetPercent / 100)`; `projectedFree = freeBalance - newMargin`; reject if `projectedFree < safeAmount`.
- Log: `{name}: دارایی امن کافی نیست (آزاد {free} - مارجین {margin} = {projectedFree} < دارایی امن {safeAmount}) — رد شد`
- Notification math (control name `دارایی امن (Safe Asset)`, hashtag `#دارایی_امن`):
```
کل دارایی = {totalAssets.toFixed(4)} USDT
موجودی آزاد = {freeBalance.toFixed(4)} USDT
مارجین ورودی جدید = {newMargin.toFixed(4)} USDT
درصد دارایی امن = {safeAssetPercent}%
دارایی امن = {totalAssets.toFixed(4)} × {safeAssetPercent}% = {safeAmount.toFixed(4)} USDT
موجودی آزاد پیش‌بینی‌شده = {freeBalance.toFixed(4)} - {newMargin.toFixed(4)} = {projectedFree.toFixed(4)} USDT
{projectedFree.toFixed(4)} < {safeAmount.toFixed(4)} ✗
```

**Control 2 — Price Distance (فاصله قیمت) — ONLY if symbol found in freshOpenPositions AND symbolLastEntryPrice !== null**:
- Long: `distancePercent = ((symbolLastEntryPrice - price) / symbolLastEntryPrice) * 100`
- Short: `distancePercent = ((price - symbolLastEntryPrice) / symbolLastEntryPrice) * 100`
- Reject if `distancePercent < effMinPriceDistancePercent`.
- Log: `فاصله قیمت کافی نیست (آخرین ورود: {last}, فعلی: {price}, فاصله: {d}% < {min}%) — رد شد` / pass: `فاصله قیمت OK ({d}% ≥ {min}%)`; if no last entry: `آخرین ورود هم‌جهت در تاریخچه یافت نشد — کنترل قیمت انجام نشد`.
- Notification math (name `فاصله قیمت (Price Distance)`, hashtag `#فاصله_قیمت`):
```
آخرین قیمت ورود هم‌جهت = {symbolLastEntryPrice}
قیمت فعلی = {price}
جهت سیگنال = {لانگ|شورت}
فاصله = (آخرین ورود - فعلی) / آخرین ورود × 100        ← Long variant
فاصله = ({last} - {price}) / {last} × 100
فاصله = {distancePercent.toFixed(4)}%
حداقل فاصله قیمت = {effMinPriceDistancePercent}%
{d.toFixed(4)}% < {min}% ✗
```
(Short formula line: `فاصله = (فعلی - آخرین ورود) / آخرین ورود × 100`)

**Control 3 — Max Margin Per Symbol (سقف مارجین) — ONLY if symbol in freshOpenPositions**:
- `existingSymbolMargin = parseFloat(symbolPosition.margin || 0)`; `maxMarginPerSymbol = totalAssets * (maxMarginPerSymbolPercent / 100)`; `totalSymbolMargin = existingSymbolMargin + newMargin`; reject if `totalSymbolMargin > maxMarginPerSymbol`.
- Log: `سقف مارجین نماد ({total} > {max} USDT) — رد شد` / pass `مارجین نماد OK ({total} ≤ {max} USDT)`.
- Notification math (name `سقف مارجین نماد (Max Margin Per Symbol)`, hashtag `#سقف_مارجین`):
```
کل دارایی = {totalAssets.toFixed(4)} USDT
درصد سقف مارجین نماد = {maxMarginPerSymbolPercent}%
سقف مارجین نماد = {totalAssets.toFixed(4)} × {maxMarginPerSymbolPercent}% = {maxMarginPerSymbol.toFixed(4)} USDT
مارجین موجود نماد = {existingSymbolMargin.toFixed(4)} USDT (از ستون «مارجین» جدول پوزیشن‌های باز)
مارجین ورودی جدید = {newMargin.toFixed(4)} USDT
مجموع مارجین نماد = {existing.toFixed(4)} + {newMargin.toFixed(4)} = {totalSymbolMargin.toFixed(4)} USDT
{total.toFixed(4)} > {max.toFixed(4)} ✗
```
- If symbol NOT in open positions: log `نماد در پوزیشن‌های باز یافت نشد — کنترل‌های فاصله قیمت و سقف مارجین skip شدند`.

**Control 4 — Positive Margin (مارجین مثبت) — ALWAYS runs**:
- `finalMargin = Math.max(newMargin, 0)`; reject if `finalMargin <= 0`. Log `مارجین نهایی صفر یا منفی — رد شد`.
- Notification math (name `مارجین مثبت (Positive Margin)`, hashtag `#مارجین_مثبت`):
```
کل دارایی = {totalAssets.toFixed(4)} USDT
درصد مارجین ورودی = {effEntryMarginPercent}%
مارجین محاسبه‌شده = {totalAssets.toFixed(4)} × {effEntryMarginPercent}% = {newMargin.toFixed(4)} USDT
مارجین نهایی = max({newMargin.toFixed(4)}, 0) = {finalMargin.toFixed(4)} USDT
{finalMargin.toFixed(4)} ≤ 0 ✗
```
All risk blocks return `{ success:false, action:'risk_blocked', errorCount:0, symbols }` and set symbol status 'waiting' in-memory.

**Risk-block notification template** (`notifyRiskControlBlocked(controlName, math)`):
```
🚫 جلوگیری از باز شدن پوزیشن
⭐ نماد: {symbol}
{🔵|🔴} جهت سیگنال: {لانگ|شورت}
🚦 کنترل فعال: {controlName}

📐 قیاس ریاضی:
{math}

🕐 زمان رویداد: {toJalali(now)}
{hashtag}
```
Hashtag routing by substring: contains 'فاصله قیمت'→#فاصله_قیمت; 'دارایی امن'→#دارایی_امن; 'سقف مارجین'→#سقف_مارجین; 'مارجین مثبت'→#مارجین_مثبت; 'کندل هم‌جهت' or 'کندل هم جهت'→#کندل_هم‌جهت; else `#کنترل_ریسک`.

### A.19 Step 13 — openPosition flow & order placement
- POST `/api/create-position` body:
```json
{
  "symbol": "XRP",                       // short name
  "direction": "long" | "short",         // selectedSignal.type lowercased
  "usdtAmount": finalMargin,
  "leverage": effLeverage,
  "tpPrice": selectedSignal.tp,
  "slPrice": selectedSignal.sl,
  "clientOrderId": generateOrderId(Date.now(), symbol.name),  // {SYM}_{YYYYMMDD}_{HHMMSS}
  "settings": { "apiKey": ..., "secretKey": ..., "baseUrl": ... }
}
```
- `!ok` → throw `errBody.error || 'Failed to create position (HTTP {status})'`.
- Response: `createData.order || createData`; log `پوزیشن باز شد (سفارش: {order.orderId}, مقدار: {order.origQty})`.
- **/api/create-position internals (Toobit)**:
  1. If `leverage > 1`: signed POST `/api/v1/futures/leverage` params `{symbol: fullSymbol, leverage, timestamp, recvWindow:'60000'}` (fire-and-forget), then 200ms delay.
  2. Current price: GET `${baseUrl}/quote/v1/ticker/price?symbol={fullSymbol}`; `currentPrice = Array.isArray ? parseFloat(priceData[0].p) : parseFloat(priceData.price || priceData.p)`.
  3. **Contract size & qty**: `const contractSize = 0.11` (hardcoded); `notional = usdtAmount * (leverage || 1)`; `quantity = notional / (currentPrice * contractSize)`; `quantity = Math.ceil(quantity)` (round UP to integer contracts).
  4. Order: signed POST `/api/v1/futures/order` params `{symbol: fullSymbol, side: 'BUY_OPEN'|'SELL_OPEN', type: 'LIMIT', quantity, priceType: 'MARKET', newClientOrderId: clientOrderId || {symbol}_{Date.now()}, timestamp, recvWindow: '60000'}`; 200ms delay after.
  5. TP/SL if provided: signed POST `/api/v1/futures/position/trading-stop` params `{symbol: fullSymbol, side: 'LONG'|'SHORT', timestamp, recvWindow: '60000', takeProfit: tpPrice?, tpTriggerBy: 'CONTRACT_PRICE', stopLoss: slPrice?, slTriggerBy: 'CONTRACT_PRICE'}` (fire-and-forget, errors ignored).
  6. Returns `{ success: true, order: orderData }`.
  - ⚠️ SECURITY: create-position and close-position routes contain HARDCODED fallback API key/secret literals (`X8eeI84g9Prh...` / `CimriVFjSdI7...`) — must NOT be replicated in the rebuild.
- **Position record structure**: the engine does NOT persist a local position record — positions live on Toobit (open-positions / history-positions are the source of truth). A generic `Positions` KV module exists (id, created_at, updated_at auto-added; updateBySymbol; getAll filters `status !== 'CLOSED'`) for UI/db routes, but the cycle engine never writes it.

### A.20 Step 13.5 — refetch balance (for notification)
GET `/api/balance` again (same headers); on failure keep old `balance` (silent catch).

### A.21 Step 14 — notifyOpenPosition (Bale message)
```
[if closedCount > 0 && closedPositionInfo]
🔒 بسته شدن پوزیشن معکوس
⭐ نماد: {closedPositionInfo.symbol || symbol.name}
{🔴|🔵} جهت: {شورت|لانگ}                    ← opposite of signal direction
🔢 اهرم: {closedPositionInfo.leverage || automationSettings.leverage}x
💵 مارجین: {closedPositionInfo.margin.toFixed(4)} USDT
{📈|📉} سود/زیان: {unrealizedPnL.toFixed(4)} USDT ({profitRate.toFixed(2)}%)

[else if closedCount > 0 (no info)]
🔒 بسته شدن پوزیشن معکوس
⭐ نماد: {symbol.name}
{icon} جهت: {text}
🔢 اهرم: {automationSettings.leverage}x

[else]
⚠️ پوزیشن مخالف جهت بستن وجود نداشت

🚀 ورود به پوزیشن جدید
⭐ نماد: {symbol.name}
{🔵|🔴} جهت: {لانگ|شورت}
💰 قیمت ورود: {price}
🎯 حد سود: {selectedSignal.tp.toFixed(4)}
🛑 حد ضرر: {selectedSignal.sl.toFixed(4)}
💵 مارجین: {finalMargin} USDT
🔢 اهرم: {effLeverage}x
🏦 موجودی کل: {updatedBalance.total || '-'} USDT
🏦 موجودی آزاد: {updatedBalance.free || '-'} USDT
🕐 زمان صدور سیگنال: {toJalali(signal.timestamp)}
🕐 زمان رویداد: {toJalali(now)}
#ورود_پوزیشن
```
(directionIcon: Long=🔵 شورت=🔴 … inverse for the closed section.)

### A.22 Cycle end & error handling (catch block)
- Success return: `{ success: true, action: 'position_opened', errorCount: 0, logs, duration, symbols }`; log `چرخه {name} با موفقیت انجام شد`; status 'waiting' (in-memory).
- `finally { await flushLogs() }` — flushLogs is a no-op (Transaction Buffer; logs returned in result).
- Catch: if message === 'NO_SIGNAL_GENERATED' → no_signal return. Otherwise:
  - log `خطای چرخه: {message}` (error).
  - Re-read `automation_symbols` from KV; find symbol with `status === 'running'`; `errorCount++`.
  - Re-read automation_settings (defaults + DB).
  - If `errorCount >= allowedErrors`: reset `errorCount = 0`, `status = 'waiting'`, `lastCycleTime = Date.now()`; log `{name}: خطا به حد مجاز رسید - عبور از نماد` (error); send skip notification:
```
⏭️ عبور از نماد
⭐ نماد: {name}
📝 تعداد خطاها به حد مجاز رسید - خطاها ریست شد و به نماد بعدی پرش شد
🕐 زمان رویداد: {toJalali(now)}
#عبور_نماد
```
  - Else: `status = 'error'`; log `{name}: خطا - {message} (تلاش {errorCount}/{allowedErrors})`; send:
```
❌ خطای اتوماسیون
⭐ نماد: {name}
📝 پیام: {message}
🕐 زمان رویداد: {toJalali(now)}
#خطا
```
  - `await AutomationState.set('automation_symbols', symbols)` (real KV write); return `{ success:false, action:'error', errorCount, symbols }`.
  - Note: the catch-block sendBaleNotification is a separate `sendBaleNotificationCatch` that only tries /api/bale-send (no KV pending queue).

### A.23 Persistence & KV keys (logs/results)
- **KV key layout** (database.js): `automationState:<key>` for AutomationState; `settings:<key>`; `logs` (max 500); `positions`; `signals`; `trades`; `errors`. Plus a RAW KV key `lastCycleLogs` (written directly by /api/run-cycle, not via database.js).
- Engine-used AutomationState keys: `automation_settings`, `marketSignalSettings`, `automation_symbols`, `pendingBaleMessages`, `lastPositionCloseTime`.
- **Transaction Buffer** (پیشنهاد ۱+۶): during the cycle ALL state updates are in-memory; ~3 KV writes per /api/run-cycle call total: (1) `automation_symbols` (once after all cycles — but note the engine ALSO does 1 write at cycle start for lastCycleTime), (2) `lastCycleLogs` direct put, (3) `logs` batch append. Comment: 3 × 288 cron calls/day = 864 writes/day (under 1,000/day KV limit).
- `lastCycleLogs` structure (written by /api/run-cycle from the LAST cycle result):
```json
{
  "timestamp": "ISO",
  "source": "cron" | "manual",
  "logCount": N,
  "logs": [
    { "id": 1, "symbol": "", "action": "automation_cycle",
      "status": "ERROR" | "WARNING" | "SUCCESS",
      "message": "...", "error_code": "SIGNAL_ERROR" | null,
      "details": "{\"timestamp\":\"ISO\",\"type\":\"info\",\"source\":\"cron\"}",
      "created_at": "ISO" }
  ]
}
```
- Shared `logs` array: /api/run-cycle maps ALL results' logs to `{symbol, action:'automation_cycle', status, message, error_code, details, created_at}` and calls `AutomationLogs.appendBatch(allNewLogs)` — one read+append+write, ids = maxId+i+1, trimmed to last 500.

### A.24 Lock / anti-concurrency
- **NO explicit lock/mutex/flag exists.** Mitigations instead:
  1. Cron fires every 5 min; tradeWaitTime (default 60 min) + immediately-persisted `lastCycleTime` at cycle start prevents the same symbol being re-picked by the next cycle (the "lock" is effectively lastCycleTime).
  2. Batch/in-memory logging avoids the old read-modify-write race where concurrent cycles overwrote each other's logs.
  3. Symbol `status: 'running'` is set only in-memory during the cycle (cosmetic; UI reads it), catch-block error path still uses it to find the running symbol.
- Concurrency exposure: two simultaneous /api/run-cycle calls (e.g., manual + cron) can still pick the same symbol within the same instant.

### A.25 checkClosedPositionsHistory(baseUrl) — closed positions notifications (مورد ۸)
- Called by /api/run-cycle AFTER the LAST cycle only (Fix مشکل ۲ — prevents duplicate notifications when cyclesPerRun > 1).
- Reads automation_settings + marketSignalSettings from KV; API keys from marketSettings (`apiKey`, `secretKey`, `baseUrl || 'https://api.toobit.com'`); missing → `{success:false, error:'API keys not configured'}`.
- GET `/api/history-positions` (headers X-API-Key/X-Secret-Key/X-Base-Url) → proxies Toobit `GET /api/v1/futures/historyPositions` (signed, NO symbol filter → ALL symbols).
- Normalizes response (array | data[] | result[] | any array value).
- Sorts DESC by `closeTime`; `firstCloseTime = parseInt(newest.closeTime)`.
- Compares with KV `automationState:lastPositionCloseTime` (parseInt, 0 if absent). If equal or 0 → `{success:true, newPositions:0, closeTime}`. (Note: uses closeTime not id — "بهبود KV".)
- New positions detected → `notifyCount = closedPositionsNotifyCount || 10`; `toNotify = cpRecords.slice(0, notifyCount)`.
- Persian numerals: map 0-9 → ۰۱۲۳۴۵۶۷۸۹.
- Message format (3 lines per position, numbered with Persian digits):
```
📋 تاریخچه پوزیشن‌های بسته‌شده
(blank)
۱. ⭐ نماد: XRP | 💰 قیمت بسته: 0.55
   🔵 جهت: Long | 📈 سود/زیان: 12.3400 USDT (2.50%) | 🔢 لوریج: 4x
   🕐 زمان: 1403/05/12 - 14:30:00
۲. ...
(blank)
🕐 زمان رویداد: {toJalali(now)}
#تاریخچه_بسته
```
- Per record: `shortSym = symbol.replace('-SWAP-USDT','').replace('USDT','')`; `sideText = side==='SHORT' ? 'Short' : 'Long'` (icons 🔴/🔵); `closePrice = pos.closeAvgPrice || '-'`; `realizedPnL`, `realizedPnlRate` (pnlIcon 📈 if >=0 else 📉, `${realizedPnL.toFixed(4)} USDT` + `(${realizedPnlRate.toFixed(2)}%)`); `leverage` + 'x'; `closeTime` → toJalali.
- Send: DIRECT fetch `https://tapi.bale.ai/bot{token}/sendMessage` with `Content-Type: 'text/plain'`, body `JSON.stringify({chat_id: String(chatId), text})`; success if `response.ok || response.status === 0`. If failed → push `{text, token, chatId, timestamp}` into `automationState:pendingBaleMessages` (trim to last 50).
- Saves `lastPositionCloseTime = firstCloseTime` to KV regardless of send success (prevents re-notify).
- Returns `{ success: true, newPositions, closeTime, baleSent, baleQueued, baleToken: 'configured'|'missing', baleChatId: 'configured'|'missing' }`.

### A.26 Pending Bale messages mechanism (Cloudflare fix)
- Reason: Cloudflare edge can't reach tapi.bale.ai (DNS error 1016 — Bale hosted in Iran); browsers in Iran CAN reach it.
- Server side (`sendBaleNotification(text)` in cycle-engine):
  1. token/chatId from automationSettings; missing → `{ok:false, error:'Not configured'}`.
  2. Method 1: POST `{baseUrl}/api/bale-send` `{token, chatId, text}`; if `data.ok` → done.
  3. Method 2 (fallback): read `automationState:pendingBaleMessages` (array), push `{text, token, chatId, timestamp: ISO}`, keep only last 50, write back; log `پیام بله در صف ارسال مرورگر ذخیره شد (سرور نمی‌تواند به tapi.bale.ai برسد)`; return `{ok:false, error:'Queued for browser delivery', queued:true}`.
- Browser side (automation-manager.js `sendPendingBaleMessages()`, runs on page load): reads `pendingBaleMessages` via dbGet; for each msg fetches `https://tapi.bale.ai/bot{msg.token}/sendMessage` with `mode:'no-cors'`, `Content-Type: 'text/plain'`, body `JSON.stringify({chat_id: String(msg.chatId), text: String(msg.text)})`; failed messages are kept and written back; log `{n} پیام بله معوق از مرورگر ارسال شد`.

### A.27 Helpers inside cycle-engine
- `generateOrderId(timestamp|Date, symbol)`: `${symbol}_${YYYY}${MM}${DD}_${HH}${MM}${SS}` (zero-padded, local time of the Date object).
- `toJalali(date?)`: Tehran offset +3:30 applied via `utcTime = getTime() + getTimezoneOffset()*60000; tehranTime = new Date(utcTime + 3.5*60*60000)`; jalali conversion algorithm (days = 355666 + 365*gy + floor((gy2+3)/4) − floor((gy2+99)/100) + floor((gy2+399)/400) + gd + g_d_m[gm−1]; jy = −1595 + 33*floor(days/12053) …); output `${jy}/${MM}/${DD} - ${HH}:${mm}:${ss}`.

## B. /api/run-cycle route (src/app/api/run-cycle/route.ts)
- `runtime = 'edge'`; GET and POST both → `handleRunCycle(request)`.
- **Auth**: `source = url.searchParams.get('source')`; `isCron = source === 'cron'`. If cron → require header `X-Run-Cycle-Secret` === `process.env.RUN_CYCLE_SECRET` (missing env or mismatch → 401 `{success:false, error:'Unauthorized: invalid or missing secret'}`). **Manual (non-cron) calls have NO auth.**
- `await initializeDatabase()`.
- baseUrl: `${url.protocol}//${request.headers.get('host') || 'localhost:3000'}`.
- POST body optional `{ symbol: string }` → symbolOverride (invalid JSON body ignored).
- **cyclesPerRun (مورد ۷)**: read from `automation_settings` (parsed.cyclesPerRun, number ≥ 1), `Math.min(x, 10)`, default 1.
- Loop: `for i in 0..cyclesPerRun-1`: `runCycle(baseUrl, {symbolOverride, triggerSource: isCron?'cron':'manual'})`; collect results; 1s `setTimeout` delay between cycles (rate-limit protection), skipped after last.
- After loop: `checkClosedPositionsHistory(baseUrl)` (once) → historyResult.
- Persist symbols: `[...results].reverse().find(r => r.symbols)` → `AutomationState.set('automation_symbols', symbols)` (single write).
- Write `lastCycleLogs` EVERY call (no debounce) via `getRequestContext()` from `@cloudflare/next-on-pages` → `ctx.env.TRADING_DATA.put('lastCycleLogs', JSON.stringify(cycleLogEntry))` (only if last result has logs; silently skipped off-Cloudflare).
- If logsWritten: batch-append ALL cycle logs via `AutomationLogs.appendBatch(allNewLogs)`.
- **Response shape**: `{ success: anySuccess, results: CycleResult[], cyclesRun: results.length, historyCheck: historyResult, duration: ms }`; errors → 500 `{ success:false, error: message, duration }`.

## C. Cron worker (cloudflare/cron-worker/)
- Separate Cloudflare Worker because **Cloudflare Pages does NOT support Cron Triggers**.
- wrangler.toml: `name = "tradebot-cron-worker"`, `main = "src/index.ts"`, `compatibility_date = "2024-07-01"`, `compatibility_flags = ["nodejs_compat"]`, `[triggers] crons = ["*/5 * * * *"]` (**every 5 minutes**), `[vars] APP_URL = "https://tradebot-b9u.pages.dev"` (override via `wrangler secret put APP_URL`), secret `RUN_CYCLE_SECRET` (must match Pages app env), `[observability] enabled = true`.
- Env interface: `{ APP_URL: string; RUN_CYCLE_SECRET: string }`.
- `scheduled` handler → `ctx.waitUntil(triggerCycle(env))`.
- `fetch` handler: `/health` → `{ok:true, service:'tradebot-cron-worker', time}`; anything else → auth via `?secret=` query param OR `X-Run-Cycle-Secret` header vs env.RUN_CYCLE_SECRET (401 `{error:'Unauthorized', hasSecret}`) then runs triggerCycle and returns its JSON.
- `triggerCycle(env)`: POST `${APP_URL.trimTrailingSlash}/api/run-cycle?source=cron` with headers `Content-Type: application/json` + `X-Run-Cycle-Secret: env.RUN_CYCLE_SECRET || ''`, body `{}`. Response JSON parsed and echoed. Return shape `{ ok, triggeredAt, result?, error?, appUrl?, hasSecret? }`. Logs `[CRON] ...` lines.

## D. Toobit signing (src/lib/tradebot/helpers.ts)
- **Edge-compatible only** (Web Crypto; no Node `crypto` import). All callers must `await generateSignature(...)`.
- `buildSortedQuery(params: Record<string,string>): string`:
  `Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&')` — **keys sorted alphabetically (byte order), both key AND value percent-encoded**.
- `generateSignature(queryString, secretKey): Promise<string>`:
  - `crypto.subtle.importKey('raw', new TextEncoder().encode(secretKey), {name:'HMAC', hash:'SHA-256'}, false, ['sign'])`
  - `crypto.subtle.sign('HMAC', key, new TextEncoder().encode(queryString))`
  - hex encode: `Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('')`
- Request patterns used by routes:
  - **GET**: URL = `${baseUrl}/path?${qs}&signature=${sig}`; headers `X-BB-APIKEY: apiKey` (+ `Content-Type: application/json` on some routes).
  - **POST (order-type)**: body = `${qs}&signature=${sig}` (form-urlencoded payload); headers `X-BB-APIKEY` + `Content-Type: application/x-www-form-urlencoded`.
  - Signed params always include `timestamp: Date.now().toString()` and `recvWindow: '60000'` (open-positions uses `'5000'`; history defaults `'5000'`).
  - **Exception**: /api/history builds its query MANUALLY (not sorted): `symbol={symbol}&limit={limit||100}&recvWindow={recvWindow||5000}&timestamp={ts}` then `&signature=` appended — order: symbol, limit, recvWindow, timestamp.
- `getSettingsFromRequest(body, headers)`: apiKey = `body.settings.apiKey || header 'X-API-Key' || process.env.TOOBIT_API_KEY || ''`; secretKey = `body.settings.secretKey || 'X-Secret-Key' || TOOBIT_SECRET_KEY || ''`; baseUrl = `body.settings.baseUrl || 'X-Base-Url' || process.env.TOOBIT_BASE || 'https://api.toobit.com'`.
- Toobit endpoints used across routes: `GET /quote/v1/klines` (public, via /api/toobit-proxy → `https://api.toobit.com/quote/v1/klines?symbol=&interval=&limit=`), `GET /quote/v1/ticker/price` (public), `GET /api/v1/futures/balance`, `GET /api/v1/futures/positions`, `GET /api/v1/futures/historyPositions`, `GET /api/v1/futures/userTrades`, `POST /api/v1/futures/leverage`, `POST /api/v1/futures/order`, `POST /api/v1/futures/position/trading-stop`.

## E. Bale notification (/api/bale-send + engine usage)
- **API URL**: `https://tapi.bale.ai/bot{token}/sendMessage`.
- /api/bale-send POST `{ token, chatId, text }` (all required → 400 `'token, chatId and text are required'`).
  - fetch with `method:'POST'`, `headers: {'Content-Type': 'application/json'}`, `body: JSON.stringify({ chat_id: String(chatId), text: String(text) })`.
  - Non-JSON response → 502 `{ok:false, error:'Bale API returned non-JSON response (status {s}): {first 200 chars}'}`.
  - !ok → `{ok:false, error: data.description || data.message || 'Bale API error', details: data}` with Bale's HTTP status.
  - ok → `{ok:true, result: data}`. Exceptions → 500 `{ok:false, error:'Internal server error: {msg}'}`.
- Engine usage: all cycle notifications go through `sendBaleNotification` (A.26) → tries /api/bale-send first, then queues in KV `pendingBaleMessages`. checkClosedPositionsHistory tries DIRECT tapi.bale.ai fetch (text/plain) then queues.
- Full message-template inventory (all with hashtags): risk-block (`🚫 جلوگیری از باز شدن پوزیشن` … #کنترل_ریسک / #فاصله_قیمت / #دارایی_امن / #سقف_مارجین / #مارجین_مثبت / #کندل_هم‌جهت), open position (`🚀 ورود به پوزیشن جدید` … #ورود_پوزیشن, optionally prefixed by `🔒 بسته شدن پوزیشن معکوس` section), automation error (`❌ خطای اتوماسیون` … #خطا), symbol skip (`⏭️ عبور از نماد` … #عبور_نماد), closed-positions history (`📋 تاریخچه پوزیشن‌های بسته‌شده` … #تاریخچه_بسته).

## F. Key numbers to replicate
- tradeWaitTime 60 min; allowedErrors 3; leverage 4 (L/S); entryMargin 5% (L/S); safeAsset 50%; maxMarginPerSymbol 10%; minPriceDistance 0.5% (L/S); signalExpiration 6 h; minSameDirectionCandles 0; closedPositionsNotifyCount 10; cyclesPerRun 1 (cap 10); cron */5 * * * *; contractSize **0.11**; qty = ceil(notional/(price×0.11)); notional = margin×leverage; history limit 100; klines limit 1000 interval 1h; TP/SL mult Long 20/6, Short 24/4; RSI 30/70; volMult 0.2 (L/S); breakAtrMultiplier 0.20 (L/S); lookback 50; recvWindow 60000; logs cap 500; pending Bale cap 50; KV writes target ≤ ~864/day.

## G. Notes / gotchas for rebuild
1. No real lock — anti-concurrency relies on immediately-persisted lastCycleTime + 5-min cron cadence.
2. engine writes `automation_symbols` at cycle START (lastCycleTime) AND /api/run-cycle writes the final symbols state after all cycles (Transaction Buffer).
3. `lastCycleLogs` is a RAW KV key (bypasses database.js prefixing); everything AutomationState uses `automationState:` prefix.
4. Hardcoded Toobit API key/secret fallbacks in create-position/close-position — SECURITY BUG, do not copy.
5. RSI helper has a quirk: `rs = avgLoss === 0 ? 100 : avgGain/avgLoss` (RS=100 when zero losses — unusual but verbatim).
6. Persian typo "عبو" in one log message (verbatim from source; keep or fix consciously).
7. Bale direct-send in checkClosedPositionsHistory uses `Content-Type: text/plain` and treats `status === 0` as OK; browser send uses `no-cors` so it can't verify success.
8. Signal loop is `i < N - 1` (last/live candle never generates a signal).
9. Phase 17 fallback chain: direction-specific ?? legacy (e.g. `rsiLongThreshold ?? marketSettings.rsiThreshold ?? 30`).
10. close-position quantity also `Math.ceil()`; close order is LIMIT + priceType MARKET with SELL_CLOSE/BUY_CLOSE.
11. /api/run-cycle manual path is UNAUTHENTICATED (only cron path checks the secret) — consider auth in the rebuild.
12. `checkClosedPositionsHistory` compares `closeTime` (not id) of the newest closed position vs KV `lastPositionCloseTime`.

---
Task ID: audit-2

# Audit 2 — Signal Logic & Strategy (RESEARCH ONLY, no code written)

Files analyzed:
- /tmp/tradebot-ref/public/js/shared/signal-utils.js (246 lines)
- /tmp/tradebot-ref/public/js/automation-manager.js (4436 lines; analyzeMarketData, calculateSignalStatus, Fake Breakout SM, daily levels, candle-close, TP/SL, signal IDs)
- /tmp/tradebot-ref/public/js/market-signal-analyzer.js (1015 lines)
- /tmp/tradebot-ref/public/init-settings.js (89 lines)

## A. Indicator Math (signal-utils.js, class SignalUtils, static methods)

### A.1 RSI — calculateRSI(data, period=14)
- **Smoothing: Wilder (RMA)** after a simple-average seed.
- Pseudocode (i loops 1..N-1 over candles):
  - change = close[i] − close[i−1]; gain = max(change,0); loss = max(−change,0)
  - if i ≤ period: avgGain += gain; avgLoss += loss; at i === period → avgGain /= period; avgLoss /= period; **push null**
  - if i > period: avgGain = (avgGain·(period−1) + gain)/period; avgLoss = same; rs = (avgLoss === 0 ? 100 : avgGain/avgLoss); push 100 − 100/(1+rs)
- **CRITICAL INDEX-ALIGNMENT BUG (verified with node):** `rsiValues.push()` runs once per loop iteration i=1..N-1 → returned array has **length N−1**, and the value pushed at iteration i lands at **array index i−1**. Therefore `rsi[k]` is the RSI of **candle k+1**.
  - All callers (automation-manager analyzeMarketData AND market-signal-analyzer analyzeData) do `rsi[i]` while iterating candle i → they evaluate the RSI of the **NEXT candle (i+1)** = **1-candle lookahead**. On the last analyzed candle (i=N−2) they read the RSI of candle N−1 = the **still-forming candle** → live repainting.
  - Also first non-null value appears at array index `period` (= candle period+1), one candle later than textbook Wilder (first RSI at candle `period`); nulls occupy rsi[0..period−1].
  - `data[i].rsi = rsi[i]` also stores the shifted value → market-data table shows candle i+1's RSI on row i.
- Quirk: when avgLoss = 0 → rs forced to 100 → RSI = 100 − 100/101 = **99.0099…** (never exactly 100).
- if data.length < period → array of nulls.

### A.2 ATR — calculateATR(data, period=14)
- TR[0] = high[0] − low[0]; TR[i] = max(high[i]−low[i], |high[i]−prevClose|, |low[i]−prevClose|).
- atr[0] = TR[0]; atr[i] = ((period−1)·atr[i−1] + TR[i]) / period → **Wilder RMA**, but **seeded with the single first TR** (not SMA of first `period` TRs — non-standard warm-up; converges asymptotically).
- Array is **index-aligned** with candles (length N). No off-by-one. Default period 14.

### A.3 SMA — calculateSMA(data, period)
- sma[i] = mean(x[i−period+1 .. i]) for i ≥ period−1, else **null**. Accepts objects (uses `.close`) or raw numbers.
- avgVols = SMA over candle **`amount`** (Toobit kline field index 5), period = avgVolPeriod (default 50). Index-aligned; null for first 49 candles. In automation: `SignalUtils.calculateSMA(data.map(d => d.amount), avgVolPeriod)`.

### A.4 calculateTPSL (legacy — **DEAD CODE** for signal gen)
- riskDistance = atr·atrMultiplier (default 2); Long: tp = price + riskDistance, sl = price − riskDistance/2; Short mirrored. NOT called by automation-manager or market-signal-analyzer (both inline their own TP/SL). Reference only.

### A.5 calculateSignalStatus(currentPrice, signal) (price-based — also UNUSED)
- 'سود (TP)' if price beyond tp; 'زیان (SL)' if beyond sl; else 'فعال'. Both apps use their own history-based status instead.

### A.6 Utilities
- validateSettings: required keys symbolName, interval, limit, lookback, volMult, avgVolPeriod, rsiThreshold, rsiPeriod, atrPeriod; limit ∈ [10,2000]; rsiThreshold ∈ [0,100]. (Uses `!settings[key]` → value 0 treated as missing.)
- **generateOrderId(timestamp, symbol)** → `` `${symbol}_${YYYY}${MM}${DD}_${HH}${MM}${SS}` `` using **LOCAL timezone** of the runtime (getFullYear/getHours…). Used as the signal's clientOrderId (from candle timestamp) AND as a **fresh** id (Date.now()) for the actual exchange order at open — the signal id ≠ exchange order id.
- formatNumber(num, decimals=4) = toFixed; formatPrice = en-US locale; formatDate = fa-IR locale. Candle parsing done by callers via `new Date(c[0])` (accepts ms number or string).

## B. Signal Generation (automation-manager.js)

### B.1 analyzeMarketData(symbol) — data prep
- Raw klines = this.marketData (arrays from /api/toobit-proxy; fullSymbol = `${symbol}-SWAP-USDT`; interval/limit from settings, defaults 1h/1000). Mapped: timestamp = new Date(c[0]) (open time), open=c[1], high=c[2], low=c[3], close=c[4], amount=c[5].
- settings = {...localStorage.marketSignalSettings, then overrides from this.settings: interval, limit, lookback, atrPeriod, rsiPeriod, avgVolPeriod, tpLongMult, slLongMult, tpShortMult, slShortMult, long/shortFixedTp/Sl, htfConfirmationSource (from DOM, default 'signalCandleClose')}.
- Indicators: atr = ATR(data, atrPeriod‖14); avgVols = SMA(amount, avgVolPeriod‖50); rsi = RSI(data, rsiPeriod‖14) — with the A.1 off-by-one.

### B.2 Daily levels (previous-day H/L/C)
- **offset = 3.5·3600·1000 = UTC+3:30 (Iran) → day boundary = midnight Tehran.**
- For each candle: localTs = ts + offset; dayKey = floor(localTs / 86400000).
- Per dayKey bucket: maxHigh = running max(high), minLow = running min(low), lastClose = close of the candle with the **largest localTs** in that day (for the current, incomplete day this is the still-forming candle's close), lastTs.
- days = sorted dayKeys. For each candle i: prevDay = days[days.indexOf(dayKey(i)) − 1] → **previous day PRESENT IN DATA** (gaps skipped); arrays prevDailyHighs[i], prevDailyLows[i], prevDayCloses[i] (automation) = that day's maxHigh/minLow/lastClose; null if no earlier day.
- Dashboard extra: dates[i] = new Date(dayKey·86400000 − offset) (day midnight) and **dailyCloses[i] = current day's lastClose** (used for its HTF check — lookahead for historical candles).

### B.3 Meaningful-break conditions (used by state machine AND by filter)
- breakDistanceLong = (atr[i]‖0) · breakAtrMultiplierLong (default 0.20; fallback chain: breakAtrMultiplierLong → legacy breakAtrMultiplier → 0.20). Same for Short.
- **Wick method (default):** isMeaningfulBreakLong = prevDailyLows[i] ≠ null && **low[i] ≤ prevDailyLows[i] − breakDistanceLong**; isMeaningfulBreakShort = prevDailyHighs[i] ≠ null && **high[i] ≥ prevDailyHighs[i] + breakDistanceShort**.
- **Close method:** close[i] ≤ prevDailyLows[i] − dist / close[i] ≥ prevDailyHighs[i] + dist.
- Directional multipliers are Phase-17 additions (breakAtrMultiplierLong/Short, defaults 0.20).

### B.4 Break Lifecycle state machine (enableBreakLifecycleManagement, default **true**)
- State: `{ active, type: 'Long'|'Short'|null, breakCandleIndex, waitingRecovery, recovered, recoveryCandleIndex }`; reset = all null/false.
- Main loop: **for i = 1; i < N − 1** (candle 0 and the LAST candle excluded — last candle = still forming).
- Per candle, in order:
  1. **Expiry:** if active && !recovered && (i − breakCandleIndex > lifetime) → reset. lifetime = breakSequenceLifetime > 0 ? breakSequenceLifetime : (lookback ‖ 50) → **default 50 candles** (breakSequenceLifetime default 0 = use lookback).
  2. **New break:** if (!active || recovered) → Long meaningful break sets {active, type Long, breakCandleIndex i, waitingRecovery true}; else Short break similarly.
  3. **Replacement:** if active && !recovered → an **opposite-direction** meaningful break REPLACES the state (new breakCandleIndex = i). A same-direction new break while waiting is ignored (original break candle kept, so expiry counts from the original break).
  4. **Recovery:** if active && waitingRecovery → Long: **close[i] > prevDailyLows[i]** (closes back above prev-day low); Short: **close[i] < prevDailyHighs[i]**. NOTE: level is prevDailyLows[i] **of the recovery candle's own day context** (not frozen at break time; across midnight the reference level shifts to the previous day = the break day). Sets recovered = true, recoveryCandleIndex = i, waitingRecovery = false.
  5. **Signal on the recovery candle:** if recovered && recoveryCandleIndex === i → evaluate entry conditions (B.5); then **breakState = resetBreakState() unconditionally** (break consumed whether or not a signal fired).
- **Same-candle fake-out possible:** break (deep wick beyond level) and recovery (close back inside) can be the SAME candle i → signal on that candle.

### B.5 Entry conditions (evaluated on the recovery candle in SM mode)
- Long: avgVols[i] ≠ null && **amount[i] > avgVols[i] · volMultLong** (default 0.2; fallback autoSettings.volMultLong ?? settings.volMult ?? 0.2) && rsi[i] ≠ null && **rsi[i] < rsiLongThreshold** (default 30; fallback ?? settings.rsiThreshold ?? 30) && htfConfirmLong.
- Short: amount[i] > avgVols[i] · volMultShort (0.2) && **rsi[i] > rsiShortThreshold** (default 70) && htfConfirmShort.
- Volume note: threshold is only **> 0.2× average volume** → a minimum-volume sanity bar, not a surge filter.
- RSI note: strict `<` / `>`; but remember rsi[i] is actually candle i+1's RSI (A.1).

### B.6 Legacy branch (enableBreakLifecycleManagement = false) — "original" logic
- isCrossOverPL = close[i] > prevDailyLows[i] && close[i−1] ≤ prevDailyLows[i−1]  (close crosses back ABOVE prev-day low)
- isCrossUnderPH = close[i] < prevDailyHighs[i] && close[i−1] ≥ prevDailyHighs[i−1]
- recentBreakLong = enableMeaningfulBreakFilter ? lastMeaningfulBreakLong[i] : lastCrossUnderPL[i]; must be ≤ lookback (50). Trackers store "candles since last event" (∞ if never): lastCrossUnderPL from plain close-cross-below-prev-low; lastMeaningfulBreakLong from B.3 conditions.
- condLong = isCrossOverPL && recentBreakLong ≤ lookback && volume && RSI && htf; condShort mirrored. Then same TP/SL + signal push as SM mode (but WITHOUT candleIndex? — no, legacy branch also pushes candleIndex).
- Note: the i−1 comparison uses the previous candle's **own** prev-day level → at Tehran-midnight boundaries the level value changes, which can fabricate a "cross".

### B.7 HTF confirmation (htfConfirmationSource)
- **'signalCandleClose' (default):** htfConfirmLong = close[i] > prevDailyLows[i]; htfConfirmShort = close[i] < prevDailyHighs[i] (signal candle's own close back inside prior-day range).
- **'previousDayClose':** htfConfirmLong = prevDayCloses[i] > prevDailyLows[i]; htfConfirmShort = prevDayCloses[i] < prevDailyHighs[i] (prev-day close vs prev-day levels).
- Dashboard variant (DIFFERENT): htfConfirmLong = dailyCloses[i] > prevDailyLows[i] where dailyCloses[i] = **current day's last close** → uses future/forming close on historical candles (lookahead).

### B.8 TP/SL formulas (exact; entry price = close[i] of signal candle)
- Long:
  - tp = (longFixedTp ≠ null && !NaN) ? close + close·(longFixedTp/100) : close + **atr[i]·tpLongMult** (default 20)
  - sl = (longFixedSl ≠ null) ? close − close·(longFixedSl/100) : close − **atr[i]·slLongMult** (default 6)
- Short:
  - tp = (shortFixedTp ≠ null) ? close − close·(shortFixedTp/100) : close − **atr[i]·tpShortMult** (default 24)
  - sl = (shortFixedSl ≠ null) ? close + close·(shortFixedSl/100) : close + **atr[i]·slShortMult** (default 4)
- **DEFAULT QUIRK:** shortFixedSl default = **6 (not null)** → shorts default to %-based SL (close·1.06) while their TP is ATR-based; longs are fully ATR-based by default. Fixed values are PERCENT of entry (not absolute prices).

### B.9 Signal object (this.signals.push)
```
{
  type: 'Long' | 'Short',
  timestamp: Date,        // candle OPEN time of the signal candle
  price: close[i],        // entry price = signal candle close
  tp: Number, sl: Number,
  orderId: clientOrderId, // `${symbol}_YYYYMMDD_HHMMSS` (local tz of candle timestamp)
  symbol: symbol,
  candleIndex: i          // automation only; used by minSameDirectionCandles risk control
}
```
- Candle row also gets: data[i].signal, .tp, .sl, .clientOrderId, .rsi, .atr (for table/chart/CSV).
- No `status`/`reason` fields on the object — status is computed at render time. Dashboard signal objects lack candleIndex.
- Persisted per symbol under DB keys: marketData_{sym}, processedData_{sym}, signals_{sym}, selectedSignal_{sym}, history_{sym}; signals serialized with timestamp → restored with new Date(...).

### B.10 Signal ID generation
- `SignalUtils.generateOrderId(candleTimestamp, symbol)` → `SYMBOL_YYYYMMDD_HHMMSS` in **runtime-local timezone**. One-sight-uniqueness: same symbol + same second → collision (max 1 signal per candle, so collisions only across reloads/pages).
- At position open, openPosition() generates a **new** clientOrderId from `Date.now()` — signal orderId is display/reference only.
- close-position order id: `${symbol}_close_${Date.now()}`.

### B.11 calculateSignalStatus(signal) — automation version
- openPositions = currentSymbolHistory.filter(pos.side includes 'OPEN' && includes ('BUY' for Long / 'SELL' for Short)) — sides are Toobit history strings like BUY_OPEN / SELL_OPEN.
- nextSignal = next element of this.signals; window = [signalTime, nextSignalTime) (nextTime = ∞ for latest).
- matching = open positions with posTime in window:
  - none → latest signal? → **'در انتظار'** (waiting, yellow) unless expired → **'منقضی شده'** (expired, orange); non-latest → **'باز نشده'** (never opened, gray).
  - matched → text = **earliest matching position's open time** formatted fa-IR (green) — acts as "opened at …". There is NO literal 'باز شده' string in the code.
- isSignalExpired(signal): (Date.now() − signalTime) > (settings.signalExpirationHours ‖ 6)·3600·1000. **Expiration only applies to the LATEST signal** and only when no matching position opened.
- updateSelectedSignal(): selectedSignal = latest signal ONLY if status.text === 'در انتظار'; expired/latest-opened → not selected (ready-signal card empty). Rendered in renderSelectedSignal().
- Dashboard calculateSignalStatus: same matching logic but no expiration and early-returns if there are no OPEN positions at all.

### B.12 Candle-closed detection
- **NO explicit openTime + interval vs now check exists.** The kline endpoint returns the in-progress candle as the last array element; the signal loop `for (i = 1; i < N − 1; i++)` **excludes the last candle** (treats it as forming) and also candle 0. Everything is recomputed from a full refetch each cycle.
- Cycle engine timing: automation `setInterval(runCycle, 5·60·1000)` (every 5 min); per-symbol throttle `selectNextSymbol()` requires now − lastCycleTime ≥ tradeWaitTime·60·1000 (default 60 min); first ready symbol in list order is picked.
- Caveats: (1) RSI off-by-one leaks the forming candle's RSI into the last analyzed candle (A.1); (2) minSameDirectionCandles confirmation counts the forming last candle (below).

### B.13 minSameDirectionCandles (risk control #6, at TRADE time not signal time)
- If > 0 (default 0 = off): sigIdx = selectedSignal.candleIndex; candlesAfterSignal = currentSymbolData.length − sigIdx − 1 (**includes the forming last candle**). If < N → reject (wait for more candles). Then candles sigIdx+1 … sigIdx+N must ALL match: Long → green (close > open), Short → red (close < open). Any opposite candle (or doji: close === open fails both) → reject with Bale risk-control notification. Runs AFTER closeOppositePositions, BEFORE refreshing history/opening.

### B.14 runCycle order (context for rebuild)
1. selectNextSymbol (wait-time throttle) → 2. setupForCycle() clears data/UI (currentSymbolHistory kept until here) → 3. fetchMarketData → 4. updateVisualization → analyzeMarketData → 5. fetchPositionHistory (limit 100; mapped {time,symbol,price,qty,commission,side,realizedPnl}) → 6. render + updateSelectedSignal → 7. if no selectedSignal → skip symbol (waiting, errorCount 0) → 8. fetchPrice (latest 1h kline close from /api/toobit-proxy) → 9. closeOppositePositions (opposite side market close; capture closedPositionInfo) → 10. minSameDirectionCandles → 11. refresh history + open positions (X-API-Key headers from marketSignalSettings) → 12. fetchBalance → 13. calculateNewMargin = totalAssets·(entryMarginPercent/100), toFixed(2) → 14. checkSafeAsset: free − newMargin ≥ totalAssets·(safeAssetPercent/100) → 15. (only if symbol in open positions) price-distance: Long (lastEntry−current)/lastEntry·100 ≥ minPriceDistancePercent; Short (current−lastEntry)/lastEntry·100; and max margin: existingMargin + newMargin ≤ totalAssets·(maxMarginPerSymbolPercent/100) → 16. finalMargin = max(newMargin, 0) must be > 0 → 17. openPosition POST /api/create-position {symbol, direction, usdtAmount, leverage, tpPrice, slPrice, clientOrderId(new)} → 18. refresh balance, Bale notifyOpenPosition, persist.
- **Phase-17 direction-specific fields are stored but NOT used at trade time:** sizing uses legacy `entryMarginPercent`, `leverage`, `minPriceDistancePercent` (saveSettings sets legacy = the Long values). Only breakAtrMultiplier + rsi/volMult use Long/Short variants (in signal generation).
- Error handling: allowedErrors (default 3) consecutive errors → symbol skipped + notify.

## C. Defaults

### C.1 init-settings.js → localStorage `marketSignalSettings` (dashboard/settings page source)
| key | default |
|---|---|
| symbolName | 'DOT' |
| interval | '1h' |
| limit | 1000 |
| lookback | 50 |
| volMult | 0.2 |
| avgVolPeriod | 50 |
| rsiThreshold | 50 |
| rsiPeriod | 14 |
| atrPeriod | 14 |
| tpLongMult | 20 |
| slLongMult | 6 |
| tpShortMult | 24 |
| slShortMult | 4 |
| longFixedTp | null |
| longFixedSl | null |
| shortFixedTp | null |
| shortFixedSl | 6 |
| htfConfirmationSource | 'signalCandleClose' |
| apiKey / secretKey | '' |
| baseUrl | 'https://api.toobit.com' |

Init flow: write defaults to localStorage if absent → async DB sync: /api/db/automation-state?key=settings_apiKeys (apiKey/secretKey/baseUrl override local) and /api/settings?key=marketSignalSettings (merge {...defaults, ...local, ...db}).

### C.2 automation-manager getDefaultSettings() → localStorage+DB `automation_settings`
| key | default |
|---|---|
| safeAssetPercent | 50 |
| maxMarginPerSymbolPercent | 10 |
| tradeWaitTime | 60 (minutes) |
| allowedErrors | 3 |
| signalExpirationHours | 6 |
| minSameDirectionCandles | 0 |
| cyclesPerRun | 1 |
| closedPositionsNotifyCount | 10 |
| enableMeaningfulBreakFilter | true |
| breakDetectionMethod | 'Wick' ('Close' alternative) |
| enableBreakLifecycleManagement | true |
| breakSequenceLifetime | 0 (0 → fallback = lookback = 50 candles) |
| rsiLongThreshold | 30 |
| rsiShortThreshold | 70 |
| volMultLong / volMultShort | 0.2 / 0.2 |
| leverageLong / leverageShort | 4 / 4 |
| breakAtrMultiplierLong / Short | 0.20 / 0.20 |
| entryMarginPercentLong / Short | 5 / 5 |
| minPriceDistancePercentLong / Short | 0.5 / 0.5 |
| entryMarginPercent (legacy) | 5 |
| minPriceDistancePercent (legacy) | 0.5 |
| leverage (legacy) | 4 |
| breakAtrMultiplier (legacy) | 0.20 |
| interval | '1h' |
| limit | 1000 |
| lookback | 50 |
| atrPeriod | 14 |
| rsiPeriod | 14 |
| avgVolPeriod | 50 |
| tpLongMult / slLongMult | 20 / 6 |
| tpShortMult / slShortMult | 24 / 4 |
| longFixedTp / longFixedSl | null / null |
| shortFixedTp / shortFixedSl | null / 6 |
| baleToken / baleChatId | '' / '' |

Precedence: defaults → localStorage `automation_settings` → DB `automation_settings` → migrate strategy params + Bale creds from `marketSignalSettings` if no automation_settings saved yet.

### C.3 Other defaults
- market-signal-analyzer getDefaultSettings: identical to C.1 but WITHOUT htfConfirmationSource.
- Default symbols (automation, if none stored): [{DOT}, {BTC}, {ETH}] each {status:'waiting', errorCount:0, lastCycleTime:null}, ids 1..3.
- Timing: automation loop every 5 min; per-symbol tradeWaitTime 60 min; signal expiry 6 h; lookback window 50 candles; history API limit 100.

## D. Key audit findings / rebuild gotchas
1. **RSI off-by-one (HIGH):** rsi array length N−1 and shifted — callers read candle i+1's RSI for candle i; last analyzed candle uses the FORMING candle's RSI (repaint). ATR/SMA are aligned. Fix in rebuild: return length-N arrays (push placeholder at index 0).
2. **Dashboard HTF lookahead (HIGH):** market-signal-analyzer uses current-day lastClose (future info) vs prev-day levels. Automation options ('signalCandleClose' / 'previousDayClose') are both causal.
3. **shortFixedSl default = 6** → Short SL %-based by default while Long is ATR-based; fixed TP/SL are PERCENTAGES of entry.
4. **Direction-specific Phase-17 fields unused at trade time** — margin/leverage/price-distance use legacy (= Long) values only.
5. **Signal ID is local-timezone-dependent** (SYMBOL_YYYYMMDD_HHMMSS) and regenerated (Date.now()) for the actual exchange order.
6. Status vocabulary: 'در انتظار' / 'باز نشده' / 'منقضی شده' / open-time string (green) — no 'باز شده' literal; expiry only for the latest signal and only if never opened.
7. Candle-close = implicit (loop excludes last candle + full refetch every cycle); no openTime+interval check. minSameDirectionCandles includes the forming candle in its count.
8. Day boundary = **midnight Tehran (UTC+3:30)** via fixed +3.5 h offset; prev-day = previous day present in data; recovery/HTF levels are evaluated against the candle's own day context (not frozen at break time).
9. Same-candle break+recovery allowed (single-candle fake-out signal).
10. Break replacement only for OPPOSITE direction; same-direction re-break does not refresh the break candle (expiry counts from original break).
11. Legacy dead code in signal-utils: calculateTPSL + price-based calculateSignalStatus (unused).
12. Volume filter is `amount > 0.2 × SMA50(amount)` — low bar, not a spike filter.
---
Task ID: audit-3
Date: 2026-02-27 (session)
Scope: RESEARCH-ONLY catalog of Toobit exchange API usage across all /api routes + auth + settings + frontend key flow. No code written. Signing algorithm already documented in audit-1 §D (buildSortedQuery + HMAC-SHA256 hex via Web Crypto) — NOT repeated here; only endpoint-level contracts.

# Audit 3 — Toobit API Endpoint Catalog (TradeBot-Production)

Files analyzed: src/app/api/{toobit-proxy, balance, create-position, close-position, open-positions, history, history-positions, settings}/route.ts, src/app/api/auth/{login, verify, update-credentials, logout}/route.ts, src/app/api/db/automation-state/route.ts, src/lib/tradebot/helpers.ts, public/{settings.html, trading.html, login.html, auth-check.js, init-settings.js}, public/js/{automation-manager.js, market-signal-analyzer.js}.

## A. Toobit API Endpoint Catalog

### A.0 Global conventions
- **Base URL**: `https://api.toobit.com` (default everywhere; overridable per-request via header `X-Base-Url` or `body.settings.baseUrl`, or env `TOOBIT_BASE`). EXCEPTION: `/api/toobit-proxy` hardcodes the base URL (no override possible).
- **API-key header sent to Toobit**: `X-BB-APIKEY: <apiKey>` (Toobit's own convention, note the unusual casing).
- **Public endpoints** (no signature): `/quote/v1/klines`, `/quote/v1/ticker/price`.
- **Signed endpoints** (HMAC-SHA256, audit-1 §D): all `/api/v1/futures/*`.
- **Signed GET pattern**: URL = `${baseUrl}${path}?${buildSortedQuery(params)}&signature=${hexHmac(sortedQS, secretKey)}`; headers `X-BB-APIKEY` (+ `Content-Type: application/json` on some routes, harmless).
- **Signed POST pattern**: body = `${buildSortedQuery(params)}&signature=${hexHmac(sortedQS, secretKey)}` sent with `Content-Type: application/x-www-form-urlencoded` + `X-BB-APIKEY`.
- **Timeouts**: NONE. No `AbortController`/`AbortSignal`/timeout option is used anywhere. All Toobit fetches rely on platform defaults (Cloudflare Edge). Only inter-call sleeps exist: 200 ms after leverage call and after order create (create-position), 300 ms between close orders when >1 position (close-position).
- **recvWindow values**: `60000` everywhere EXCEPT `/api/open-positions` route (uses `5000`) and `/api/history` (default `5000`, overridable in body).
- **Symbol format**: Toobit full format is `{SYMBOL}-SWAP-USDT` (e.g. `DOT-SWAP-USDT`). Routes split: create-position/close-position accept the BARE symbol (`DOT`) and build `fullSymbol = ${symbol}-SWAP-USDT` server-side; `/api/history` and `/api/toobit-proxy` expect the CALLER to pass the full symbol (frontend passes `${symbol}-SWAP-USDT`). Quirk: market-signal-analyzer.js fetchData uses `symbolName + 'USDT'` (SPOT-style, e.g. `DOTUSDT`, no `-SWAP-`) for klines and it works — Toobit klines accepts both formats.
- **Internal key pickup (helpers.ts getSettingsFromRequest(body, headers))**: apiKey = `body.settings.apiKey || header 'X-API-Key' || env TOOBIT_API_KEY || ''`; secretKey same with `X-Secret-Key`/TOOBIT_SECRET_KEY; baseUrl same with `X-Base-Url`/TOOBIT_BASE → `https://api.toobit`. Used ONLY by balance / open-positions / history-positions. create-position and close-position read `body.settings.*` → env → **hardcoded leaked keys fallback** (see A.9). /api/history reads TOP-LEVEL body fields (no `settings` wrapper, no headers, no env).

### A.1 Master table

| # | Internal route (method) | Toobit call | Public/Signed | Params → where | recvWindow | Consumed response fields |
|---|---|---|---|---|---|---|
| 1 | `GET /api/toobit-proxy` | `GET https://api.toobit.com/quote/v1/klines?symbol=&interval=&limit=` | Public | symbol, interval, limit (all string) → query (client-supplied, already-full symbol) | n/a | raw passthrough; candle array [0]=time(ms), [1]=open, [2]=high, [3]=low, [4]=close, [5]=amount, [7]=value (idx 7 used only by market-signal-analyzer) |
| 2 | `GET /api/balance` (keys via headers) | `GET {base}/api/v1/futures/balance?recvWindow=60000&timestamp=&signature=` | Signed GET | timestamp, recvWindow → query (sorted: recvWindow first) | 60000 | balance/total, availableBalance/available/free, positionMargin/position_margin, orderMargin/order_margin/frozen, crossUnRealizedPnl/unrealizedPnl/unrealized, asset/coin/currency/symbol |
| 3 | `GET /api/open-positions` (keys via headers) | `GET {base}/api/v1/futures/positions?recvWindow=5000&timestamp=&signature=` | Signed GET | timestamp, recvWindow → query | **5000** | passthrough as `{positions}`; consumers read symbol, side ('LONG'/'SHORT'), available, position, margin, unrealizedPnL, profitRate, leverage, avgPrice, markPrice |
| 4 | `GET /api/history-positions` (keys via headers) | `GET {base}/api/v1/futures/historyPositions?recvWindow=60000&timestamp=&signature=` | Signed GET | timestamp, recvWindow → query. **NO symbol param → ALL symbols** | 60000 | raw passthrough; engine reads id, symbol, side, closeTime, closeAvgPrice, realizedPnL, realizedPnlRate, leverage |
| 5 | `POST /api/history` (keys in body top-level) | `GET {base}/api/v1/futures/userTrades?symbol=&limit=&recvWindow=&timestamp=&signature=` | Signed GET (internal route is POST) | symbol (FULL `{S}-SWAP-USDT`), apiKey, secretKey, baseUrl, limit (default 100), recvWindow (default 5000) → body; Toobit query is built MANUALLY in order `symbol, limit, recvWindow, timestamp` (NOT sorted — signature covers exactly that string) | 5000 | raw passthrough; consumers read time, symbol, price, qty, commission, side, realizedPnl |
| 6 | `POST /api/create-position` (keys in body.settings) | 3–4 calls: POST `/api/v1/futures/leverage`, GET `/quote/v1/ticker/price`, POST `/api/v1/futures/order`, POST `/api/v1/futures/position/trading-stop` | leverage/order/trading-stop signed POST; ticker public | see §B | 60000 | ticker: `[0].p` or `.price`/`.p`; order: orderId, origQty; leverage & trading-stop responses IGNORED |
| 7 | `POST /api/close-position` (keys in body.settings) | GET `/api/v1/futures/positions` (recvWindow 60000) then POST `/api/v1/futures/order` per position | both signed | see §C | 60000 | positions: symbol, side, available/position; order response only `response.ok` checked |
| 8 | (create-position step) | `GET {base}/quote/v1/ticker/price?symbol={SYMBOL}-SWAP-USDT` | Public | symbol → query | n/a | `priceData[0].p` (array form) else `priceData.price || priceData.p` |

### A.2 GET /api/toobit-proxy (klines)
- Edge runtime, GET only. Query params (all required, else 400 `{error:'Missing required parameters'}`): `symbol`, `interval`, `limit` — passed through `encodeURIComponent` into `https://api.toobit.com/quote/v1/klines?symbol=&interval=&limit=` (base URL hardcoded).
- No auth of any kind (public market data; no app auth either — unauthenticated proxy).
- Response: Toobit JSON returned verbatim. Kline format = array of arrays: `[time, open, high, low, close, amount, ?, value]` (numbers as strings; index 6 unused).
- Errors: non-ok upstream → `{error:'Failed to fetch from Toobit API'}` with upstream status; fetch exception → 500 `{error:'Internal server error: <msg>'}`.
- Callers: automation-manager (symbol `-SWAP-USDT`, interval from settings default 1h, limit default 1000); market-signal-analyzer (symbol `+ 'USDT'`); cycle-engine (`${baseUrl}/api/toobit-proxy?...` with full symbol, interval/limit from KV marketSignalSettings, defaults 1h/1000). Engine validates: `Array.isArray(rawData) && rawData.length>0 && Array.isArray(rawData[0])`.

### A.3 GET /api/balance
- Keys from headers (getSettingsFromRequest(null, request.headers)); missing keys → 401 `{error:'API keys not configured', message:'Please configure your API keys in settings page', success:false}`.
- Toobit params (query, sorted): `recvWindow=60000&timestamp={Date.now()}` + `&signature=` appended. Headers: `X-BB-APIKEY`, `Content-Type: application/json`.
- Response normalization (very defensive, 5 shapes): top-level array → use; `data` array; `result` array; `balances` array; single object having `asset` or `currency` → wrap in array. Else 500 `{error:'Unknown response structure', rawData}`.
- USDT row found by `asset || coin || currency || symbol` === 'USDT' (case-insensitive); missing → 404 `{error:'No USDT balance found', rawData}`.
- Field extraction (primary → alt → 0): total = `balance|total`; available = `availableBalance|available` (fallback chain `free|availableBalance`); positionMargin = `positionMargin|position_margin`; orderMargin = `orderMargin|order_margin|frozen`; unrealizedPnL = `crossUnRealizedPnl|unrealizedPnl|unrealized`. **free = available − orderMargin** (computed).
- Output: `{success:true, balance:{asset, total, available, free, positionMargin, orderMargin, unrealizedPnL, fetchedAt}}` — all numbers `.toFixed(4)` strings.
- Upstream non-ok → passthrough status `{error:'Failed to fetch balance', details:<errorText>}`; exception → 500 `{error:<msg>}`.

### A.4 GET /api/open-positions
- Keys from headers; 401 shape: `{error:'API keys not configured', message:'Please configure your API keys in settings page', positions:[]}` (note: empty array so callers can degrade gracefully).
- Toobit: `GET {base}/api/v1/futures/positions?recvWindow=5000&timestamp=&signature=` (sorted QS; recvWindow 5000 — the ONLY route using 5000 via buildSortedQuery). Headers `X-BB-APIKEY` + `Content-Type: application/json`.
- Response: array → itself, else `data || result` → output `{positions}`.
- Non-ok → passthrough `{error:'Failed to fetch positions', details}`; exception → 500.
- Note: automation-manager `getSymbolMargin()` also sends an `X-Symbol: {SYM}-SWAP-USDT` header — the route IGNORES it (filtering happens client-side). All position field consumption is client/engine-side (symbol, side, available, position, margin, unrealizedPnL, profitRate, avgPrice, markPrice, leverage).

### A.5 GET /api/history-positions
- Keys from headers (route comment: cycle engine reads keys from KV itself and forwards as headers). 401 `{error:'API keys not configured', message:'Please configure your API keys in settings page', success:false}`.
- Toobit: `GET {base}/api/v1/futures/historyPositions?recvWindow=60000&timestamp=&signature=`. **Deliberately no symbol param** → returns closed positions for ALL symbols (used by engine's closed-positions-history check).
- Response: raw Toobit JSON passthrough. Non-ok → `{error:'Failed to fetch closed positions history', details}` + status; exception → 500.
- Engine consumption (checkClosedPositionsHistory): normalize (array | data | result | first array-valued field), sort by `closeTime` DESC, dedupe vs KV `lastPositionCloseTime` (compare newest `closeTime`, NOT id), take first `closedPositionsNotifyCount` (default 10) records; per record reads `symbol, side, closeAvgPrice, realizedPnL, realizedPnlRate, leverage, closeTime, id`. After notify: `AutomationState.set('lastPositionCloseTime', firstCloseTime)`.

### A.6 POST /api/history (userTrades)
- Body (JSON): `{symbol, apiKey, secretKey, baseUrl, limit?, recvWindow?}` — keys are TOP-LEVEL (no settings wrapper!). All of symbol/apiKey/secretKey/baseUrl required → else 400 `{error:'Missing required parameters'}`.
- Toobit: `GET {base}/api/v1/futures/userTrades?symbol={symbol}&limit={limit||100}&recvWindow={recvWindow||5000}&timestamp={Date.now()}&signature={hmac}` — **query string is built MANUALLY, unsorted, in exactly this order: symbol, limit, recvWindow, timestamp** (and `signature` appended after). This is the documented exception to buildSortedQuery. Params not percent-encoded (safe since symbol has no reserved chars).
- Headers: `X-BB-APIKEY` only. Response: raw passthrough. Non-ok → `{error:'Failed to fetch from exchange API', details}` + status; exception → 500 `{error:'Internal server error: ...'}`.
- Callers must pass the FULL symbol (`{S}-SWAP-USDT`) themselves.
- Consumer normalization (identical in automation-manager and cycle-engine): array → itself; `data` array; `result` array; else first array-valued property. Map to `{time: new Date(parseInt(item.time)), symbol, price: parseFloat, qty, commission, side, realizedPnL}`.

### A.7 POST /api/v1/futures/leverage (via create-position)
- Only called if `leverage && leverage > 1`. Signed POST, form-urlencoded body: sorted QS of `{symbol: fullSymbol, leverage: String(leverage), timestamp, recvWindow: '60000'}` → `leverage=...&recvWindow=60000&symbol=DOT-SWAP-USDT&timestamp=...&signature=...`. Headers `X-BB-APIKEY` + `Content-Type: application/x-www-form-urlencoded`.
- **Response is completely ignored (fire-and-forget)** — a leverage failure does not abort the order. 200 ms sleep after.

### A.8 POST /api/v1/futures/order (open + close orders)
- Signed POST, form-urlencoded body = sortedQS + signature. Params for OPEN (create-position):
  `newClientOrderId={clientOrderId||`${symbol}_${Date.now()}`}&priceType=MARKET&quantity={qty}&recvWindow=60000&side={BUY_OPEN|SELL_OPEN}&symbol={fullSymbol}&timestamp={ts}&type=LIMIT&signature=...`
  - **`type: 'LIMIT'` + `priceType: 'MARKET'` and NO `price` field** — Toobit's market-execution-via-limit pattern (verbatim quirk, replicate).
  - `quantity` is an integer string (Math.ceil, see §B).
- Params for CLOSE (close-position): same shape but `side` = `SELL_CLOSE` (closing LONG) or `BUY_CLOSE` (closing SHORT), `quantity` = `Math.ceil(parseFloat(pos.available || pos.position))`, `newClientOrderId = clientOrderId || close_${Date.now()}_${closedCount}`.
- side mapping: direction 'long'→'BUY_OPEN'/'LONG' positions; 'short'→'SELL_OPEN'/'SHORT'.
- Open-order errors: non-ok → `{error:'Failed to create order', details: errorText}` + upstream status (the ONLY Toobit call whose error is checked in create-position). Close-order errors: collected into `errors[]` per position; success counted per `response.ok`.
- Response fields consumed downstream: `orderId`, `origQty` (read by cycle-engine/automation-manager from `data.order || data`).

### A.9 Security: hardcoded leaked Toobit keys (CRITICAL, do NOT replicate)
- create-position and close-position both fall back to hardcoded production keys when `body.settings` and env are absent:
  - apiKey `X8eeI84g9PrhgxmfCqilP9GR8gTWy9TEyfh2vG8DoTGOXwxDSwqqh2zusT69429j`
  - secretKey `CimriVFjSdI7POG4B4pzNRxsxZNrhltDnRwq95vshhtZFyjnW2JVrX6pcH8v9z6H`
- The same keys are ALSO hardcoded as `value="..."` defaults of the api-key/secret-key inputs in public/settings.html (lines 140/149) — shipped in static HTML.
- In the rebuild: keys must come ONLY from authenticated KV/env; never hardcoded; never returned to the browser.

## B. create-position — full order flow (POST /api/create-position)
1. **Client params (JSON body)**: `symbol` (bare, e.g. "DOT"), `direction` ('long'|'short', lowercased before compare), `usdtAmount` (margin in USDT — number, REQUIRED with symbol+direction else 400 `{error:'Missing required parameters'}`), `leverage` (number; call skipped if falsy or ≤1), `clientOrderId` (optional; default `` `${symbol}_${Date.now()}` ``), `tpPrice` (optional number/null), `slPrice` (optional number/null), `settings: {apiKey, secretKey, baseUrl}` (optional — env/hardcoded fallbacks otherwise).
2. fullSymbol = `${symbol}-SWAP-USDT`.
3. **Leverage call** (A.7) — only if leverage>1; response ignored; 200 ms sleep.
4. **Price fetch**: `GET {base}/quote/v1/ticker/price?symbol={fullSymbol}` (public, unsigned, uses the settings baseUrl). `currentPrice = Array.isArray(priceData) ? parseFloat(priceData[0].p) : parseFloat(priceData.price || priceData.p)`. No error handling — non-numeric → NaN propagates into qty.
5. **Quantity formula** (verbatim):
   ```
   contractSize = 0.11                      // hardcoded USDT-m contract size
   notional     = usdtAmount * (leverage || 1)
   quantity     = Math.ceil(notional / (currentPrice * contractSize))
   ```
   Quantity is an integer number of contracts, rounded UP.
6. **Order call** (A.8 open params). Error → abort with `{error:'Failed to create order', details}` + upstream status. Success → `orderData` parsed; 200 ms sleep.
7. **TP/SL call** (only if `tpPrice || slPrice` truthy): `POST {base}/api/v1/futures/position/trading-stop`, form-urlencoded sortedQS:
   - base params: `symbol={fullSymbol}`, `side={LONG|SHORT}` (positionSide from direction), `timestamp`, `recvWindow='60000'`.
   - if tpPrice: `takeProfit={tpPrice}` + `tpTriggerBy='CONTRACT_PRICE'`.
   - if slPrice: `stopLoss={slPrice}` + `slTriggerBy='CONTRACT_PRICE'`.
   - Sorted key order (all params): recvWindow, side, slTriggerBy, stopLoss, symbol, takeProfit, timestamp, tpTriggerBy (subset depends on which of TP/SL provided).
   - Headers `X-BB-APIKEY` + `Content-Type: application/x-www-form-urlencoded`. **Response ignored** (TP/SL failures silent).
8. **Response to client**: `{success:true, order: <raw Toobit /futures/order JSON>}`.
9. **Persistence: NONE.** The route writes no position/trade record anywhere (no KV, no DB). The frontend separately refreshes `/api/open-positions` and caches to DB key `openPositions`; the cycle engine logs and stores `lastCycleLogs`/`AutomationLogs`. In the rebuild, decide where the canonical position record is written (e.g. /api/db/positions) — the reference relies on exchange state as source of truth.
10. Edge runtime; exception → 500 `{error: <msg>}`.

## C. close-position — full close flow (POST /api/close-position)
1. **Client params**: `symbol` (bare), `direction` ('long'|'short' — direction of the position to close), `clientOrderId` (optional), `settings: {apiKey, secretKey, baseUrl}` (same env/hardcoded fallbacks).
2. fullSymbol = `${symbol}-SWAP-USDT`; required symbol+direction else 400.
3. **Fetch ALL positions**: `GET {base}/api/v1/futures/positions?recvWindow=60000&timestamp=&signature=` (signed; NOTE recvWindow 60000 here vs 5000 in the dedicated open-positions route). Headers: `X-BB-APIKEY` ONLY (no Content-Type).
4. **Filter targets**: `posSymbol.toUpperCase() === fullSymbol.toUpperCase() && side.toUpperCase() === targetSide ('LONG'|'SHORT') && parseFloat(pos.available || pos.position) > 0`. No targets → 200 `{success:false, error:'No open positions found', closed:0, total:0}` (HTTP 200, not 404).
5. **Per-position close order** (A.8 close params): side `SELL_CLOSE` for LONG / `BUY_CLOSE` for SHORT; quantity = `Math.ceil(parseFloat(pos.available || pos.position))` (⚠ over-rounds fractional sizes — e.g. available 45.5 → 46 contracts sent); type LIMIT + priceType MARKET, no price.
6. 300 ms sleep between orders only when >1 target. Per-order: `response.ok` → closedCount++, else push `Position {pos.symbol}: {errorText}` to errors.
7. **Response**: `{success: closedCount>0, closed: closedCount, total: targetPositions.length, errors: [...] (only when non-empty)}`.
8. No persistence either; caller refreshes open positions afterwards. Edge runtime; exception → 500.

## D. Settings route (/api/settings) + storage
- **GET /api/settings** (edge): `?key=<k>` → `{success:true, data: AutomationState.get(k)}` (null → data:null). No key → returns all known groups present: `{success:true, data:{marketSignalSettings?, automation_settings?, automation_symbols?, settings_apiKeys?, htfConfirmationSource?}}`. **NO AUTH.**
- **POST /api/settings**: body `{key, value}`; 400 if no key; `AutomationState.set(key, value)` (arbitrary key — can write ANY automationState:* key). Special-case: if `key==='marketSignalSettings'` and value is an object, ALSO writes `settings_apiKeys = {apiKey: v.apiKey||'', secretKey: v.secretKey||'', baseUrl: v.baseUrl||'https://api.toobit.com'}` (backwards-compat for settings.html). Returns `{success:true}`. **NO AUTH.**
- SETTINGS_KEYS map: marketSignal→`marketSignalSettings`, automation→`automation_settings`, symbols→`automation_symbols`, apiKeys→`settings_apiKeys`, htfSource→`htfConfirmationSource`.
- Actual KV keys (database.js prefixes `automationState:`): `automationState:marketSignalSettings`, `automationState:automation_settings`, `automationState:automation_symbols`, `automationState:settings_apiKeys`, `automationState:htfConfirmationSource`.
- **How API keys are stored/read**: PLAINTEXT JSON in KV (`automationState:settings_apiKeys` and inside `automationState:marketSignalSettings`). Read paths: (a) server cycle-engine loads `marketSignalSettings` from KV; (b) browser GET /api/settings & GET /api/db/automation-state (both unauthenticated) → localStorage; (c) trade routes get keys per-request (headers/body).
- **SECURITY ISSUES (rebuild must fix)**:
  1. GET /api/settings and GET /api/db/automation-state?key=settings_apiKeys return the exchange API key+secret IN PLAINTEXT to ANY unauthenticated browser (also `?key=auth_credentials` leaks the password hash).
  2. POST on both routes is unauthenticated → anyone can overwrite settings/keys/credentials (settings poisoning: point baseUrl at an attacker host to harvest signed requests).
  3. POST /api/settings accepts arbitrary `key` → can clobber any automationState key.
  4. settings.html hardcodes live API keys as input defaults (see A.9).
- Note: settings.html itself does NOT call /api/settings — it talks to /api/db/automation-state directly (dbGet/dbSet/dbDelete). /api/settings GET is consumed by init-settings.js (`?key=marketSignalSettings`). POST /api/settings currently has NO frontend caller in public/ (dormant).

## E. Auth routes
- **POST /api/auth/login** `{username, password}` (both required → 400 'نام کاربری و رمز عبور الزامی است'):
  - Credentials in KV `automationState:auth_credentials` = `{username: string, passwordHash: string}` where passwordHash = **SHA-256 hex (Web Crypto digest, UNSALTED)** of the password.
  - **Default credentials: admin/admin** — auto-created on FIRST login attempt if no creds stored (hash of 'admin' persisted).
  - Compare: `username === creds.username && sha256hex(password) === creds.passwordHash` else 401 'نام کاربری یا رمز عبور اشتباه است'.
  - Cookie: name **`auth_token`**, value `username:expiry:signature` — expiry = `Date.now() + 7*24*60*60*1000` (7 days, ms epoch); signature = **HMAC-SHA256 hex** of `${username}:${expiry}` (NOT the full 3-part cookie) with key `process.env.AUTH_SECRET || 'tradebot-default-auth-secret-change-me'`. Cookie flags: `httpOnly, secure, sameSite:'strict', path:'/', maxAge: 604800`.
  - Success `{success:true}`; 500 with console.error otherwise.
- **GET /api/auth/verify**: reads cookie `auth_token`; 401 `{success:false}` if absent/invalid; valid → `{success:true, username}` (username = first cookie segment). Validation: exactly 3 `:`-separated parts; `Date.now() <= expiry`; recomputed HMAC hex equality. **Does NOT check the username still matches stored credentials** → after update-credentials, OLD cookies stay valid until expiry.
- **POST /api/auth/update-credentials** `{newUsername, newPassword, currentPassword}` (all required → 400 'همه فیلدها الزامی است'): requires valid auth cookie (401 'احراز هویت نشده'/'احراز هویت نامعتبر'); requires stored creds (400 'هیچ اعتبارنامه‌ای تنظیم نشده'); verifies current password hash (401 'رمز عبور فعلی اشتباه است'); then writes `{username: newUsername, passwordHash: sha256hex(newPassword)}`. Existing sessions are NOT invalidated (see verify note).
- **POST /api/auth/logout**: `{success:true}` + `response.cookies.delete('auth_token')`.
- **Frontend**: every page except login.html includes auth-check.js → `fetch('/api/auth/verify', {credentials:'same-origin'})`, redirect to /login.html when !ok or network error. login.html posts JSON to /api/auth/login, redirects to /home.html on success; also pre-redirects to /home.html if already verified. settings.html has the update-credentials + logout buttons.
- **Security notes**: fallback AUTH_SECRET is a known constant (forgeable cookies when env unset); unsalted SHA-256; default admin/admin; verify ignores username validity; no rate limiting; login itself is the only auth gate (trade/settings/db routes do NOT check the cookie at all).

## F. Frontend → backend key passing (full flow)
- **localStorage (browser cache)**: key **`marketSignalSettings`** — JSON holding `{apiKey, secretKey, baseUrl, baleToken, baleChatId, symbolName, interval, limit, lookback, volMult, avgVolPeriod, rsiThreshold, rsiPeriod, atrPeriod, tpLongMult, slLongMult, tpShortMult, slShortMult, fixed tp/sl, htfConfirmationSource}`. Also localStorage `automation_settings` (strategy/risk params saved by automation.html via automation-manager).
- **Source of truth = KV**: init-settings.js runs on every page load: GET `/api/db/automation-state?key=settings_apiKeys` → overrides apiKey/secretKey/baseUrl into localStorage; then GET `/api/settings?key=marketSignalSettings` → merge `{...defaults, ...local, ...db}` (DB wins). settings.html save: localStorage write + POST /api/db/automation-state with `marketSignalSettings` AND `settings_apiKeys` (kebab-case input ids `api-key/secret-key/base-url/bale-token/bale-chat-id` → camelCase keys via regex).
- **Per-request key transport to internal API routes**:
  - GET-style routes (`/api/balance`, `/api/open-positions`, `/api/history-positions`): HTTP headers **`X-API-Key`, `X-Secret-Key`, `X-Base-Url`** (plaintext over the wire; secret in a header!).
  - `/api/create-position`, `/api/close-position`: JSON body field **`settings: {apiKey, secretKey, baseUrl}`** (trading.html ALSO sends the X-* headers on these calls, but the routes ignore headers — body.settings is authoritative; env → hardcoded fallbacks).
  - `/api/history`: keys as **top-level body fields** `apiKey`, `secretKey`, `baseUrl` (no settings wrapper).
  - `/api/toobit-proxy`: no keys (public).
- **Server-side flow (cycle-engine)**: reads keys from KV `automationState:marketSignalSettings`; calls the same internal routes over `${baseUrl}` (app origin) forwarding keys as X-* headers (GET routes) or body.settings / top-level (POST routes) — i.e. the keys make a browser→edge or edge→edge round trip in plaintext headers/body each call.
- **Other client storage**: sessionStorage `signals`, `metadata`, `historyData` (pending-signal handoff into trading.html). DB-cached UI state via `/api/db/automation-state`: `openPositions`, `balance` (written by automation-manager after each fetch).
- /api/db/automation-state (quick look): GET `?key=` single value / no key → ALL `automationState:*` (getAll; on real KV listing is limited — local JSON fallback object); POST `{key, value}` set; DELETE `?key=` (or body.key fallback). All unauthenticated. Response shapes: GET `{success, data}` / POST-DELETE `{success:true}` / errors 400 'Key is required' / 500.

## G. Rebuild checklist for the Toobit client library (from this catalog)
1. Constants: base `https://api.toobit.com`, header `X-BB-APIKEY`, recvWindow 60000 (5000 for positions/userTrades), contractSize 0.11, symbol builder `{S}-SWAP-USDT`, HMAC = audit-1 §D.
2. Endpoints to implement: klines (public), ticker/price (public), futures/balance, futures/positions, futures/historyPositions, futures/userTrades (manual unsorted query: symbol,limit,recvWindow,timestamp), futures/leverage, futures/order (LIMIT+MARKET+priceType), futures/position/trading-stop (takeProfit/tpTriggerBy, stopLoss/slTriggerBy, CONTRACT_PRICE).
3. Response normalizers to keep: balance multi-shape + USDT lookup + free=available−orderMargin; positions array/data/result; userTrades array/data/result/first-array; historyPositions sort by closeTime desc.
4. Behaviors to preserve (or consciously change): leverage/trading-stop fire-and-forget; qty Math.ceil (incl. close-side over-round); 200/300 ms sleeps; no fetch timeouts; order response passthrough.
5. Security to change: no hardcoded keys; keys never returned by settings/db routes; auth on all trade+settings routes; salted/argon password hash; real AUTH_SECRET; invalidate sessions on credential change; X-Secret-Key header eliminated in favor of server-side KV-only keys.

---
Task ID: audit-4
Date: 2026-02-27 (session, after audit-1/2/3)
Scope: RESEARCH-ONLY deep audit of STORAGE LAYER (database.js × 2, KV schema, db API routes, helpers.ts) + UI structure scan (automation.html settings modal, trading.html). No code written. Complements audit-1 (cycle engine / write strategy), audit-2 (strategy math / defaults) and audit-3 (Toobit endpoints) — this report is the STORAGE SCHEMA + UI SPEC source of truth for the rebuild.

# Audit 4 — Storage Layer (KV / JSON) + DB Routes + Settings/Trading UI Spec

## A. Storage Layer Architecture

### A.1 Dual-mode backend (`src/lib/tradebot/database.js`, 804 lines — THE real module)
- Header comment: "Cloudflare-ready (KV) with local JSON file fallback. ALL methods async."
- **Backend auto-detection** (module-level memo `let _kvCache` — undefined=unchecked, null=no KV, object=KV namespace):
  1. `getKV()` → `await import('@cloudflare/next-on-pages')` → `getRequestContext()` → `ctx.env.TRADING_DATA` (Cloudflare KV binding, created via `npx wrangler kv namespace create TRADING_DATA`, see cloudflare/DEPLOYMENT_GUIDE.md).
  2. If the dynamic import throws (local dev / Node) → `_kvCache = null` → **JSON file mode**.
- **Local mode file**: `const DB_PATH = '/home/z/my-project/lib/tradebot/trading_data.json'` — an ABSOLUTE path **committed to the GitHub repo** (verified via `git show HEAD:` — not a local edit; both database copies contain it). File shape:
  ```json
  { "settings": {}, "automationState": {}, "trades": [], "positions": [], "signals": [], "logs": [], "errors": [] }
  ```
- `loadFileDatabase()` — async, memoizes `fileDatabase` in module scope (lazy import('fs'), readFileSync, create-if-missing).
- `saveFileDatabase()` — fire-and-forget (`import('fs').then(fs => fs.writeFileSync(DB_PATH, JSON.stringify(fileDatabase, null, 2)))`) — **NOT awaited** by callers → consecutive writes race / can be lost (pretty-printed 2-space JSON).
- `initializeDatabase()` — async: logs which backend was chosen; in file mode calls loadFileDatabase(). Every route calls it before use.
- `initializeDatabaseSync()` — backward-compat Node-only loader (require('fs'), guarded by `globalThis.__tradebotFileSyncLoaded`); no-op/returns false on Edge. Not called by current routes.
- **Every collection method is read-modify-write of a WHOLE JSON array** (KV get whole array → mutate → put whole array). "Each write REPLACES the previous value (no append)" per header.

### A.2 KV key inventory (complete)
| KV key | Value shape | Writer(s) | Reader(s) | Cap / retention |
|---|---|---|---|---|
| `settings:<key>` | any JSON (Settings module) | **NOBODY — dead code** (0 call sites in src) | none | — |
| `automationState:automation_settings` | AutomationSettings object (B.9) | automation.html saveSettings → POST /api/db/automation-state; also /api/settings POST | cycle-engine ×3 sites, run-cycle route, engine getSettings | none |
| `automationState:marketSignalSettings` | MarketSignalSettings object (B.10) incl. htfConfirmationSource + apiKey/secretKey/baseUrl | settings.html + automation.html (Task-19 sync) via /api/settings & /api/db/automation-state | cycle-engine, init-settings.js, settings route | none |
| `automationState:automation_symbols` | SymbolEntry[] (B.1) | engine start-of-cycle (lastCycleTime), run-cycle final persist, frontend saveSymbols() | cycle-engine, run-cycle, frontend loadSymbols() | none (small) |
| `automationState:auth_credentials` | `{username, passwordHash}` (SHA-256 hex) | /api/auth/login (default admin/admin bootstrap), /api/auth/update-credentials | login, update-credentials | none |
| `automationState:settings_apiKeys` | `{apiKey, secretKey, baseUrl}` | /api/settings POST when saving marketSignalSettings (back-compat for settings.html) | init-settings.js, /api/db/automation-state?key= | none |
| `automationState:pendingBaleMessages` | `[{text, token, chatId, timestamp}]` (B.8) | cycle-engine sendBaleNotification Method-2 fallback; checkClosedPositionsHistory queue; automation-manager flushPendingBaleMessages re-queues failures | cycle-engine, automation-manager (browser sends via tapi.bale.ai) | **50** (slice(-50) at every write) |
| `automationState:lastPositionCloseTime` | number (ms epoch, closeTime of newest closed Toobit position) | checkClosedPositionsHistory (always, after notify attempt) | checkClosedPositionsHistory | single value |
| `automationState:htfConfirmationSource` | string | **never written as standalone key** — declared in /api/settings SETTINGS_KEYS, actual value lives INSIDE marketSignalSettings | /api/settings GET all | — |
| `trades` | Trade[] (B.4) | only POST /api/db/trades (manual; **no engine/frontend caller**) | /api/db/trades(+[param]), Analytics | read limit 1000 default; **no write cap** |
| `positions` | Position[] (B.2) | only POST /api/db/positions (manual; engine never writes — Toobit is source of truth) | /api/db/positions(+[param]) | getAll filters `status !== 'CLOSED'`; **no cap** |
| `signals` | Signal[] (B.3) | only POST /api/db/signals (manual; **no real writer**) | /api/db/signals | read limits 50/100; **no cap** |
| `logs` | LogEntry[] (B.5) | AutomationLogs.add + **appendBatch** (run-cycle single batch write) + frontend saveLogToDatabase → POST /api/db/logs | /api/db/logs GET, AutomationLogs.getBySymbol/getRecent/getErrors | **500 (KV mode only)** |
| `errors` | Error[] (B.7) | Errors.log — **never called → dead** | Errors.getRecent — no route | none |
| `lastCycleLogs` | `{timestamp, source, logCount, logs[]}` (B.6) — **RAW KV key, bypasses database.js** | /api/run-cycle direct `ctx.env.TRADING_DATA.put('lastCycleLogs', …)` (only on Cloudflare; silently skipped locally) | /api/db/logs GET direct `.get('lastCycleLogs')` (merge; only on Cloudflare) | 1 entry (latest cycle only) |
- KV values are always `JSON.stringify`-ed on write; `kvGet` JSON.parses with raw-string fallback.
- Cloudflare KV constraints the code cares about: value ≤ 25 MiB (hence logs cap 500 "to stay within KV size limits"), writes budget — comment in run-cycle: 3 writes/cron-call × 288 cron calls/day = **864 writes/day (under the 1,000/day limit)**.

### A.3 AutomationState prefix mechanism
- `AutomationState.get(key)` → `kvGet('automationState:' + key)`; `set` → `kvSet('automationState:' + key, value)`; `delete` → KV `.delete('automationState:' + key)`. File mode: `db.automationState[key]` in the single JSON blob.
- `AutomationState.getAll()` returns **{}** in KV mode ("KV doesn't easily support listing") — callers must use per-key lookups; file mode returns whole object. /api/db/automation-state GET without ?key → effectively empty on Cloudflare.
- Frontend wrapper (automation-manager.js): `dbGet(key)` → GET `/api/db/automation-state?key=<k>` → `{success, data}`; `dbSet(key, value)` → POST `/api/db/automation-state` `{key, value}`; `dbDelete(key)` → DELETE `?key=`.

### A.4 Read/write counting / instrumentation
- **NONE.** No counters, no metrics, no kv-op logging. Only `console.log` lines (init, batch-write count, cycle messages) and static comments documenting the write-budget math (864/day). The "instrumentation" is conceptual: Transaction Buffer + appendBatch (audit-1 §A.23) reduce writes to ~3 per /api/run-cycle call: (1) automation_symbols, (2) lastCycleLogs direct put, (3) logs batch — plus 1 extra engine write at cycle START for lastCycleTime (audit-1 gotcha #2).

### A.5 `src/lib/…/database.js` (804) vs `lib/…/database.js` (311) — which is real
- **src/lib/tradebot/database.js = REAL.** All imports use `@/lib/tradebot/database` (tsconfig `@/*` → `src/*`): cycle-engine, run-cycle, db/*, settings, auth/login, auth/update-credentials. Async, dual-mode KV/JSON, has AutomationState, AutomationLogs.appendBatch, initializeDatabaseSync, default export `{initializeDatabase, Settings, Trades, Positions, Signals, AutomationLogs, Errors, AutomationState, Analytics}`.
- **lib/tradebot/database.js = DEAD/older.** Sync-only, top-level `import fs from 'fs'` (would throw on Edge runtime), NO KV, NO AutomationState (has no `automationState` section in its DB shape), NO appendBatch, NO initializeDatabaseSync. **Zero imports anywhere in src/** — kept only as legacy reference. Its `export default database` (raw object) differs from src's module-object default.
- Both hardcode the SAME absolute path `/home/z/my-project/lib/tradebot/trading_data.json` (committed upstream; the dir doesn't even exist in this sandbox).

### A.6 Retention / caps summary
- logs: **500 latest** — trimmed in `AutomationLogs.add` (KV branch) AND `appendBatch` (KV branch) via `slice(-500)`. **NOT trimmed in local-file branches** (add/appendBatch file paths just push) → local JSON file grows unbounded.
- pendingBaleMessages: **50 latest** (both write sites).
- trades/signals/positions/errors: **no write caps** — whole-array read-modify-write every op; ids = `Math.max(map(id||0)) + 1`.
- Read-side limits: Trades.getAll(1000) default / getBySymbol(100)/getByStatus(100); Signals.getBySymbol(50)/getPending(100); AutomationLogs.getBySymbol(100)/getRecent(200)/getErrors(100); Errors.getRecent(100); Analytics scans up to 10000.
- run-cycle: cyclesPerRun read from automation_settings, **capped at 10**, 1 s delay between cycles.
- Frontend caps: cycle-log table keeps max 200 rows in DOM; GET /api/db/logs?limit=200 default (UI calls with 100).

### A.7 DB API route inventory (all `runtime = 'edge'`, all call `initializeDatabase()` first)
| Route | Methods | Behavior |
|---|---|---|
| /api/db/automation-state | GET ?key / GET (all), POST {key,value}, DELETE ?key (or body.key) | generic AutomationState KV CRUD (frontend persistence path) |
| /api/settings | GET ?key / GET (5 known groups), POST {key,value} | SETTINGS_KEYS = {marketSignal: marketSignalSettings, automation: automation_settings, symbols: automation_symbols, apiKeys: settings_apiKeys, htfSource: htfConfirmationSource}; POST of marketSignalSettings ALSO mirrors apiKeys into `settings_apiKeys` |
| /api/db/logs | GET ?limit=200, POST (raw body → AutomationLogs.add) | GET merges shared `logs` + RAW `lastCycleLogs` (Cloudflare only), dedupes by `created_at|message`, sorts desc, slices limit |
| /api/db/signals | GET (pending 100), POST | Signals.add → `{success, id: result.lastInsertRowid}` (**bug**: add returns `{id}` → response id is undefined) |
| /api/db/positions | GET (non-CLOSED), POST | Positions.add → same lastInsertRowid bug |
| /api/db/positions/[param] | GET ?limit (param=symbol → getBySymbol), PUT (param=id) | — |
| /api/db/trades | GET ?limit=100, POST | Trades.add → same lastInsertRowid bug |
| /api/db/trades/[param] | GET (param=symbol), PUT (param=id) | — |
| /api/db/stats, /api/db/stats/[symbol] | GET | Analytics (section E) |
| /api/auth/login, /api/auth/update-credentials | POST | auth_credentials KV (B.8); cookie `auth_token` = `username:expiry:HMACsig` (AUTH_SECRET, 7 days, httpOnly/secure/strict) |
| /api/run-cycle | GET/POST (+?source=cron with X-Run-Cycle-Secret) | writes automation_symbols (final), lastCycleLogs (raw), logs (appendBatch) — see audit-1 §B |

## B. Data Shapes (full field lists)

### B.1 SymbolEntry (array value of `automationState:automation_symbols`)
```ts
{ id: number            // 1..N, max(existing ids)+1 on insert
, name: string          // SHORT name e.g. 'DOT'; full = `${name}-SWAP-USDT`
, status: 'waiting' | 'running' | 'error'
, errorCount: number    // consecutive cycle errors
, lastCycleTime: number | null  // Date.now() ms; null = never cycled
}
```
- Defaults when empty (frontend loadSymbols + server): `[{id:1,name:'DOT'},{id:2,name:'BTC'},{id:3,name:'ETH'}]` each `{status:'waiting', errorCount:0, lastCycleTime:null}`.
- Lifecycle: selection filter = `!lastCycleTime || now-lastCycleTime ≥ tradeWaitTime*60000` (first ready symbol wins; symbolOverride by name bypasses wait). At cycle START: `lastCycleTime=Date.now()` **persisted immediately** (1 KV write; status 'running' only in-memory). At cycle END: status→'waiting' in-memory (persisted later by run-cycle final write). On thrown error: read-modify-write `errorCount++`; if `errorCount ≥ allowedErrors` → reset errorCount=0, status='waiting', lastCycleTime=Date.now() (skip symbol, Bale `#عبور_نماد`), else status='error' (Bale `#خطا`).
- Frontend mirror: localStorage `automation_symbols` (DB wins on load); per-symbol caches `automation_market_${symbol}`, `automation_signals_${symbol}`, `automation_history_${symbol}`.

### B.2 Position record (`positions` array)
- `Positions.add(position)` auto-adds: `id` (max+1), `created_at` (ISO), `updated_at` (ISO; refreshed on every update). All other fields = whatever the caller POSTs — **there is no canonical writer**: the cycle engine and create/close-position routes NEVER call Positions (Toobit exchange is the source of truth; audit-1 §A.22). The frontend also never POSTs to /api/db/positions. So `positions` KV array is effectively always empty in production.
- Module API implies shape: `{id, symbol, status, created_at, updated_at, …}` — `getAll()` filters `status !== 'CLOSED'`; `getBySymbol(symbol)` returns FIRST match (assumes ≤1 open position per symbol); `updateBySymbol(symbol, updates)`; `delete(id)` / `deleteBySymbol(symbol)` physically remove.
- Live position shape (Toobit /api/open-positions → UI): `{symbol, side ('LONG'|'SHORT' …), avgPrice, available, leverage, margin, unrealizedPnL, profitRate}`.

### B.3 Signal record (`signals` array)
- `Signals.add(signal)` auto-adds `id`, `created_at`. Engine-internal Signal type (never persisted to KV by engine): `{type:'Long'|'Short', timestamp, price, tp, sl, orderId, symbol, candleIndex?}`.
- Module API implies extra field `status` (getPending filters `status === 'PENDING'`); `getLatest(symbol)` = last array element for that symbol. **No real writer** — POST /api/db/signals is manual-only.
- Frontend pending-signal source = sessionStorage `signals` (+ `metadata`, `historyData`) written by dashboard page: signal `{type, timestamp, price, tp, sl, orderId, symbol}`; status computed client-side ('در انتظار' if latest signal with no matching OPEN history position between it and the next signal, else open-time string / 'باز نشده' / 'منقضی شده' per audit-2).

### B.4 Trade record (`trades` array)
- `Trades.add(trade)` auto-adds `id`, `created_at`, `updated_at`. Fields implied by module + Analytics: `{id, symbol, status ('CLOSED'|…), pnl, opened_at, order_id, created_at, updated_at}`. `getByOrderId(orderId)`, `getByStatus`, `getBySymbol(symbol, limit)`.
- **No writer in the running system** → /api/db/stats always zero (see E).

### B.5 Log entry (`logs` array, cap 500 KV)
```ts
{ id: number                       // maxId+1 (add) / maxId+i+1 (appendBatch)
, symbol: string | null            // e.g. 'DOT' or '' 
, action: string                   // always 'automation_cycle'
, status: 'SUCCESS' | 'WARNING' | 'ERROR'
, message: string                  // Persian log text
, error_code: null | 'SIGNAL_ERROR'  // only when type==='error'
, details: string                  // JSON.stringify({timestamp, type, source|process})
, created_at: string               // ISO timestamp
}
```
- Two producers: (a) frontend `log()` → POST /api/db/logs `{symbol, action:'automation_cycle', status, message, error_code, details:JSON.stringify({timestamp, type, process})}`; (b) server /api/run-cycle batch: maps CycleLogEntry `{message, type:'info'|'success'|'warning'|'error', symbol?, timestamp}` → log rows with `details: JSON.stringify({timestamp, type, source:'cron'|'manual'})`, then `AutomationLogs.appendBatch` (single read+append+trim500+write; enriches defaults for missing fields).
- CycleLogEntry (in-memory, CycleResult.logs): `{message, type:'info'|'success'|'warning'|'error', symbol?, timestamp:ISO}`.

### B.6 `lastCycleLogs` (RAW KV key, written by /api/run-cycle from LAST cycle result)
```ts
{ timestamp: string      // ISO now
, source: 'cron' | 'manual'
, logCount: number
, logs: Array<{ id: number        // 1..n re-numbered per entry
              , symbol: string
              , action: 'automation_cycle'
              , status: 'SUCCESS'|'WARNING'|'ERROR'   // from type
              , message: string
              , error_code: null | 'SIGNAL_ERROR'
              , details: string  // JSON.stringify({timestamp, type, source})
              , created_at: string  // l.timestamp
 }>
}
```
- Written only if last CycleResult has logs; only when `@cloudflare/next-on-pages` context exists (silent skip locally). Read by /api/db/logs GET and merged with shared logs (dedupe key `${created_at}|${message}`, sort desc).

### B.7 Error record (`errors` array — DEAD module, Errors.log never called)
```ts
{ id, type ('UNKNOWN' default), message, stack, context: object, created_at }
```

### B.8 Small keys
- `automationState:auth_credentials` = `{username: string, passwordHash: string}` (SHA-256 hex; default bootstrap admin/admin on first login).
- `automationState:settings_apiKeys` = `{apiKey: string, secretKey: string, baseUrl: string}` (baseUrl default `https://api.toobit.com`).
- `automationState:pendingBaleMessages` = `[{text: string, token: string, chatId: string, timestamp: string(ISO)}]` cap 50. Consumed by browser (automation-manager flushes via tapi.bale.ai), failures re-queued.
- `automationState:lastPositionCloseTime` = number (ms) — compared against Toobit history `closeTime` of newest closed position; equal/0 → no new notifications.

### B.9 `automationState:automation_settings` — full AutomationSettings (server interface + defaults)
| field | default | UI id (C) | notes |
|---|---|---|---|
| safeAssetPercent | 50 | safe-asset-percent | |
| entryMarginPercent | 5 | (legacy ← entry-margin-percent-long) | Long value mirrored |
| maxMarginPerSymbolPercent | 10 | max-margin-per-symbol-percent | |
| minPriceDistancePercent | 0.5 | (legacy ← -long) | Long value mirrored |
| tradeWaitTime | 60 | trade-wait-time | minutes |
| allowedErrors | 3 | allowed-errors | |
| leverage | 4 | (legacy ← leverage-long) | |
| signalExpirationHours | 6 | signal-expiration | |
| minSameDirectionCandles | 0 | min-same-direction-candles | مورد ۶ |
| closedPositionsNotifyCount | 10 | closed-positions-notify-count | مورد ۸ |
| enableMeaningfulBreakFilter | true | enable-meaningful-break-filter | |
| breakAtrMultiplier | 0.20 | (legacy ← break-atr-multiplier-long) | |
| breakDetectionMethod | 'Wick' | break-detection-method | 'Wick'\|'Close' |
| enableBreakLifecycleManagement | true | enable-break-lifecycle | |
| breakSequenceLifetime | 0 | break-sequence-lifetime | 0 = lookback |
| rsiLongThreshold | 30 | rsi-long-threshold | Phase 17 |
| rsiShortThreshold | 70 | rsi-short-threshold | |
| volMultLong / volMultShort | 0.2 / 0.2 | vol-mult-long/short | |
| breakAtrMultiplierLong / Short | 0.20 / 0.20 | break-atr-multiplier-long/short | |
| leverageLong / leverageShort | 4 / 4 | leverage-long/short | |
| entryMarginPercentLong / Short | 5 / 5 | entry-margin-percent-long/short | |
| minPriceDistancePercentLong / Short | 0.5 / 0.5 | min-price-distance-percent-long/short | |
| baleToken / baleChatId | '' / '' | (not in modal — settings.html is canonical; synced from marketSignalSettings) | |
| cyclesPerRun | (client-only; server default 1, cap 10) | cycles-per-run | saved by frontend into automation_settings; read by /api/run-cycle |

### B.10 `automationState:marketSignalSettings` — full shape (init-settings.js defaults)
```ts
{ symbolName: 'DOT'
, interval: '1h', limit: 1000, lookback: 50
, volMult: 0.2, avgVolPeriod: 50
, rsiThreshold: 50            // legacy (strategy now uses rsiLong/ShortThreshold in automation_settings)
, rsiPeriod: 14, atrPeriod: 14
, tpLongMult: 20, slLongMult: 6, tpShortMult: 24, slShortMult: 4
, longFixedTp: null, longFixedSl: null
, shortFixedTp: null, shortFixedSl: 6      // PERCENT of entry when set; null = ATR-based
, htfConfirmationSource: 'signalCandleClose'  // | 'previousDayClose'
, apiKey: '', secretKey: '', baseUrl: 'https://api.toobit.com'
, baleToken?: string, baleChatId?: string   // settings.html writes these here
}
```
- Precedence (audit-2 C.2): defaults → localStorage → DB. init-settings.js merges `{...defaultSettings, ...local, ...dbSettings}` into localStorage on every page load; API keys also mirrored from `settings_apiKeys`.
- helpers.ts (src/lib/tradebot/helpers.ts, 79 lines — audit-1 §D): `buildSortedQuery(params)` (sorted encodeURIComponent k=v&…), `generateSignature(qs, secret)` (async HMAC-SHA256 hex via Web Crypto), `getSettingsFromRequest(body, headers)` → apiKey/secretKey/baseUrl from body.settings → X-API-Key/X-Secret-Key/X-Base-Url headers → env TOOBIT_API_KEY/TOOBIT_SECRET_KEY/TOOBIT_BASE → default baseUrl.

## C. automation.html — page + settings modal UI spec (rebuild source of truth)

### C.1 Page structure (1002 lines, fa/RTL, Vazirmatn, Tailwind CDN, ECharts, FontAwesome, glass dark theme #1a1a2e→#16213e, accent #667eea/#764ba2)
- Nav: خانه (home), تنظیمات (settings), داشبورد (market_signal), خرید و فروش (trading), اتوماسیون (self). Brand: "اتوماسیون هوشمند".
- Scripts in HEAD: auth-check.js, init-settings.js, main.js, js/shared/signal-utils.js, js/shared/visualization.js, js/shared/ui-utils.js, js/automation-manager.js.
- **Sticky control bar** (top:64px): `#start-automation-btn` شروع / `#stop-automation-btn` توقف (disabled initially) / `#run-once-btn` یک چرخه / `#automation-status` (غیرفعال default) | balance trio: `#balance-total` موجودودی کل، `#balance-position-margin` در معامله، `#balance-free` آزاد (USDT) + `#refresh-balance-btn` بروزرسانی | `#toggle-settings-btn` تنظیمات (opens modal).
- **پوزیشن‌های باز** compact card (max-height 220px): 9 cols نماد/جهت/قیمت ورود/موجودی/اهرم/مارجین/سود و زیان/درصد/آخرین ورود + `#positions-count-badge`, `#positions-meta`, `#refresh-positions-btn`.
- **لیست نمادها**: 7 cols ردیف/نماد/وضعیت/تعداد خطا/آخرین چرخه/زمان انتظار/عملیات + `#clear-errors-btn` پاکسازی خطاها; rows draggable (drag-handle/drag-over classes → reorder).
- **گزارش چرخه‌ها**: 5 cols زمان/نماد/فرایند/وضعیت/جزئیات + `#clear-log-btn` پاکسازی; loads from /api/db/logs?limit=100, sorted desc; status map ERROR=خطا(red)/WARNING=هشدار(yellow)/SUCCESS=موفق(green)/else اطلاع(blue).
- **نمودار قیمت و سیگنال‌ها**: `#price-chart` (ECharts 400px, LTR) + `#chart-symbol-name` badge.
- **سیگنال آماده برای ورود**: `#ready-signal-container` (empty state: بدون سیگنال).
- **جزئیات سیگنال‌ها**: `#signal-list` (scroll 400px) + `#refresh-signals-btn` تولید سیگنال (title: تولید سیگنال بر اساس داده‌های بازار و تاریخچه فعلی).
- **داده‌های بازار**: 12 cols تاریخ/بازگشایی/بسته/بالاترین/پایین‌ترین/حجم/RSI/ATR/سیگنال/TP/SL/کد سفارش + `#refresh-market-data-btn`, `#export-market-btn` CSV (disabled until data), `#table-search` جستجو.
- **سوابق پوزیشن‌ها**: 7 cols زمان/نماد/قیمت/مقدار/کمیسیون/سمت/سود و زیان + `#refresh-all-data-btn` (تاریخچه+بازار+سیگنال+نمودار), `#export-history-btn` CSV, `#history-search`.

### C.2 Settings modal `#settings-modal` (.settings-modal, .active → flex; content max-h 85vh scroll)
Header: "تنظیمات اتوماسیون" + `#save-settings-btn` ذخیره (green) + `#reset-settings-btn` پیش‌فرض + close ✕ (`automationManager.toggleSettings()`). Body = 7 sections:

**Group 1 — مدیریت ریسک** (shield-alt icon)
| id | label (Persian) | type | default | min | max | step | help/title text |
|---|---|---|---|---|---|---|---|
| safe-asset-percent | دارایی امن % | number | 50 | 0 | 100 | 1 | حداقل درصد کل دارایی که باید آزاد بماند |
| max-margin-per-symbol-percent | سقف مارجین نماد % | number | 10 | 1 | 100 | 1 | حداکثر درصد کل دارایی برای مارجین یک نماد |
| signal-expiration | انقضا سیگنال (ساعت) | number | 6 | 1 | 48 | 1 | مدت اعتبار سیگنال قبل از انقضا |
| min-same-direction-candles | حداقل کندل هم‌جهت | number | 0 | 0 | 10 | 1 | حداقل تعداد کندل هم‌جهت بعد از سیگنال (۰ = غیرفعال) |
| min-price-distance-percent-long | فاصله قیمت بهتر % — لانگ | number | 0.5 | 0 | 50 | 0.1 | group help: حداقل فاصله قیمت بهتر برای ورود دوم بر روی یک نماد |
| min-price-distance-percent-short | فاصله قیمت بهتر % — شورت | number | 0.5 | 0 | 50 | 0.1 | (same group) |

**Group 2 — اجرای معاملات** (cogs)
| id | label | type | default | min | max | step | note |
|---|---|---|---|---|---|---|---|
| trade-wait-time | انتظار (دقیقه) | number | 60 | 1 | 1440 | 1 | |
| allowed-errors | خطای مجاز | number | 3 | 1 | 10 | 1 | |
| cycles-per-run | تعداد چرخه | number | 1 | 1 | 10 | 1 | title: تعداد چرخه در هر بار زدن دکمه «یک چرخه» |
| closed-positions-notify-count | تعداد نوتیف تاریخچه | number | 10 | 1 | 50 | 1 | title: تعداد رکوردهای ارسالی در نوتیف تاریخچه پوزیشن‌های بسته |
| leverage-long | اهرم — لانگ | number | 4 | 1 | 125 | 1 | |
| leverage-short | اهرم — شورت | number | 4 | 1 | 125 | 1 | |
| entry-margin-percent-long | نسبت مارجین ورودی % — لانگ | number | 5 | 0 | 100 | 0.5 | help: درصد کل دارایی برای مارجین هر ورودی جدید |
| entry-margin-percent-short | نسبت مارجین ورودی % — شورت | number | 5 | 0 | 100 | 0.5 | (same) |

**Group 3 — بازار** (chart-bar; Task 19 moved from settings.html)
| id | label | type | default | options/min/max/step |
|---|---|---|---|---|
| interval | تایم فریم | select | 1h (selected) | 1h=۱ ساعته, 30m=۳۰ دقیقه, 15m=۱۵ دقیقه, 4h=۴ ساعته, 1d=۱ روزه |
| limit | تعداد داده‌ها | number | 1000 | 10–2000 step 1 |
| lookback | دوره برگشت (LookBack) | number | 50 | 10–200 step 1 |
| atr-period | دوره ATR | number | 14 | 5–50 step 1 |
| rsi-period | دوره RSI | number | 14 | 5–50 step 1 |
| avg-vol-period | دوره میانگین حجم | number | 50 | 10–200 step 1 |

**Group 4 — اندیکاتورها** (chart-line)
| id | label | type | default | options/range |
|---|---|---|---|---|
| htf-confirmation-source | مبنای HTF Confirmation | select | signalCandleClose | signalCandleClose / previousDayClose; desc `#htf-source-description` (default: کلوز کندل سیگنال با سطوح روز قبل مقایسه می‌شود) |
| rsi-long-threshold | آستانه RSI — لانگ (اشباع فروش) | number | 30 | 0–100 step 1 |
| rsi-short-threshold | آستانه RSI — شورت (اشباع خرید) | number | 70 | 0–100 step 1 |
| vol-mult-long | ضریب حجم — لانگ | number | 0.2 | 0–5 step 0.05 |
| vol-mult-short | ضریب حجم — شورت | number | 0.2 | 0–5 step 0.05 |

**Group 5 — اهداف TP/SL** (bullseye; two bordered sub-cards: Long [blue, arrow-up], Short [red, arrow-down])
| id | label | type | default | range |
|---|---|---|---|---|
| tp-long-mult | ضریب TP (Long) | number | 20 | 1–100 step 1 |
| sl-long-mult | ضریب SL (Long) | number | 6 | 1–50 step 1 |
| long-fixed-tp | TP ثابت (%) (Long) | number | (empty→null) | 0.1–50 step 0.1, placeholder "خالی = ATR-based" |
| long-fixed-sl | SL ثابت (%) (Long) | number | (empty→null) | 0.1–50 step 0.1, placeholder "خالی = ATR-based" |
| tp-short-mult | ضریب TP (Short) | number | 24 | 1–100 step 1 |
| sl-short-mult | ضریب SL (Short) | number | 4 | 1–50 step 1 |
| short-fixed-tp | TP ثابت (%) (Short) | number | (empty→null) | 0.1–50 step 0.1 |
| short-fixed-sl | SL ثابت (%) (Short) | number | (empty→null) | 0.1–50 step 0.1, placeholder "مثلا: 6" |

**Group 6 — Fake Breakout** (bolt)
| id | label | type | default | values/range |
|---|---|---|---|---|
| enable-meaningful-break-filter | فیلتر شکست معنادار (ATR) | checkbox | checked | |
| break-detection-method | روش تشخیص شکست | select | Wick | Wick (Wick (High/Low)) / Close (Close (قیمت بسته)) |
| enable-break-lifecycle | مدیریت چرخه شکست | checkbox | checked | |
| break-sequence-lifetime | عمر چرخه شکست (۰ = LookBack) | number | 0 | 0–100 step 1 |
| break-atr-multiplier-long | ضریب ATR شکست — لانگ | number | 0.20 | 0.05–1.00 step 0.05 |
| break-atr-multiplier-short | ضریب ATR شکست — شورت | number | 0.20 | 0.05–1.00 step 0.05 |

**Group 7 — مدیریت نمادها** (coins)
- `#new-symbol-name` text input (placeholder "مثال: BTC", no label) + `#add-symbol-btn` افزودن (green, plus icon). addSymbol: trim + UPPERCASE, dedupe by name, id = max+1, {status:'waiting', errorCount:0, lastCycleTime:null}.

### C.3 Save flow (automation-manager.js saveSettings)
1. Collect all fields → `this.settings` (keys per B.9; legacy mirrors: entryMarginPercent/minPriceDistancePercent/leverage/breakAtrMultiplier ← Long inputs; fixed TP/SL empty string → null; baleToken/baleChatId preserved from loaded settings).
2. `localStorage.setItem('automation_settings', JSON.stringify(settings))`.
3. `dbSet('automation_settings', settings)` → KV `automationState:automation_settings`.
4. Read localStorage `marketSignalSettings`, overwrite htfConfirmationSource + interval/limit/lookback/atrPeriod/rsiPeriod/avgVolPeriod/tpLongMult/slLongMult/tpShortMult/slShortMult/longFixed(Tp|Sl)/shortFixed(Tp|Sl) from this.settings → localStorage + `dbSet('marketSignalSettings', …)` (so server cron uses same strategy params).
5. Log "تنظیمات با موفقیت ذخیره شد" + notification "تنظیمات به‌روز شدند ✓" + renderSymbolsTable.
- Load flow: localStorage automation_settings → dbGet('automation_settings') (DB wins) → cross-source sync from marketSignalSettings (baleToken/baleChatId always from MSS; strategy params migrated from MSS only if no saved automation_settings) → populateSettingsForm.
- Settings NOT in this modal: apiKey/secretKey/baseUrl + baleToken/baleChatId (settings.html owns them); symbols (Group 7 adds only).

## D. trading.html — manual trading page spec (782 lines; same theme/nav)
- Fixed balance bar (top:64): موجودودی کل `#balance-total` / در معامله `#balance-position-margin` / آزاد `#balance-free` + `#refresh-balance-btn` → GET /api/balance (headers X-API-Key/X-Secret-Key/X-Base-Url from localStorage marketSignalSettings; shows '-' if keys unset).
- **Panel "باز / بستن پوزیشن"** (merged form):
  - `#open-symbol` نماد معاملاتی — readonly, auto-filled `${symbolName}-SWAP-USDT` (from marketSignalSettings; default DOT).
  - Direction toggle: `#open-dir-long` Long / `#open-dir-short` Short (classes active-long/active-short; no default selected — alert if missing).
  - `#open-usdt` مقدار مارجین (USDT) — number step 0.1, placeholder "مثلا: 10".
  - `#open-leverage` اهرم (Leverage) — number 1–125, placeholder "پیش‌فرض: 1".
  - `#open-orderid` کد سفارش (Client Order ID) — text, placeholder "خالی بگذارید برای تولید خودکار"; auto-gen `${SYMBOL}_${YYYY}_${MM}_${DD}_${HHMMSS}` (local time).
  - `#open-tp` حد سود (Take Profit) — number step 0.0001, optional.
  - `#open-sl` حد ضرر (Stop Loss) — number step 0.0001, optional.
  - `#open-submit-btn` ایجاد پوزیشن (green) → POST /api/create-position body `{symbol, direction:'long'|'short', usdtAmount, leverage, clientOrderId, tpPrice|null, slPrice|null, settings:{apiKey, secretKey, baseUrl}}` + credential headers. Success → alert + refresh positions.
  - `#close-submit-btn` بستن پوزیشن (red) → confirm dialog ("همه پوزیشن‌های LONG/SHORT بسته شوند؟") → POST /api/close-position `{symbol, direction, clientOrderId, settings}` — closes ALL Toobit positions of that symbol+direction (reduce-only market); response `{closed: N}`. Note text: "بستن پوزیشن: همه پوزیشن‌های مربوط به این نماد و جهت بسته خواهند شد".
- **سیگنال آماده معامله** section: reads sessionStorage `signals` + `metadata` + `historyData` (written by dashboard page); picks first signal whose computed status is 'در انتظار'; card shows: type (Long green/Short red), timestamp (fa-IR), قیمت ورود (price.toFixed(4)), حد سود (tp), حد ضرر (sl), کد سفارش (orderId), نماد (`${symbol}-SWAP-USDT`), وضعیت; meta line "آخرین بروزرسانی". Empty states: "سیگنال آماده‌ای وجود ندارد / برای تولید سیگنال به صفحه داشبورد بروید" / "همه سیگنال‌ها باز شده‌اند".
- **پوزیشن‌های باز** table: 8 cols نماد/جهت/قیمت ورود (avgPrice)/موجودی (available)/اهرم (leverage x)/مارجین (margin)/سود و زیان (unrealizedPnL)/درصد (profitRate×100) + `#refresh-positions-btn` → GET /api/open-positions (live Toobit). `#positions-meta` = "آخرین بروزرسانی … | تعداد N".
- **NO KV/DB writes on this page** (only init-settings.js read-sync of localStorage). No trading-history table on this page (history lives on automation.html سوابق پوزیشن‌ها).

## E. Stats routes — what is computed and how
- **GET /api/db/stats** → `{success, trading, daily}`:
  - `trading = Analytics.getTradingStats()`: `Trades.getAll(10000)` → filter `status === 'CLOSED'` → `{total_trades, winning_trades (pnl>0), losing_trades (pnl<0), total_pnl (Σ pnl), avg_pnl (total/total_trades, 0 if none), max_profit (max(pnl,0)), max_loss (min(pnl,0))}`.
  - `daily = Analytics.getDailyStats(7)`: CLOSED trades with `new Date(trade.opened_at) ≥ now−7d`, grouped by `opened_at` ISO date (YYYY-MM-DD) → `[{date, trades, wins, daily_pnl}]`.
- **GET /api/db/stats/[symbol]** → `{success, data: getSymbolStats(symbol)}`: `Trades.getBySymbol(symbol, 10000)` → CLOSED → `{symbol, total_trades, winning_trades, total_pnl, avg_pnl}`.
- **CRITICAL**: nothing in the system ever writes Trades → all stats are always zeros in practice. For the rebuild, either sync closed positions from Toobit history into trades or compute stats on-the-fly from /api/history-positions.

## F. Key audit findings / rebuild gotchas (storage-specific)
1. **Dead KV surface**: `settings:*` prefix (Settings module) has ZERO callers; `errors` array has zero writers (no /api/db/errors route); `positions`/`trades`/`signals` arrays have no real writers (engine uses Toobit as source of truth; frontend never POSTs them) — only logs/automationState/lastCycleLogs are live. Rebuild can drop ~40% of the DB module.
2. **lib/tradebot/database.js (311 lines) is dead code** (sync fs-only, no AutomationState, unimported). src/lib version is canonical. Both share the same hardcoded absolute `DB_PATH = '/home/z/my-project/lib/tradebot/trading_data.json'` — committed upstream; must be env/path-relative in the rebuild.
3. **Local-file mode quirks**: `saveFileDatabase()` is fire-and-forget (no await → lost-write races); logs 500-cap and appendBatch trimming apply ONLY to the KV branch — local JSON logs grow unbounded; `lastCycleLogs` write/read silently skipped off-Cloudflare (local logs route gets no merge).
4. **Whole-array read-modify-write** per operation + `id = max+1` → last-write-wins races under concurrent cron+manual runs (mitigated, not eliminated, by Transaction Buffer/appendBatch).
5. Response bug: db POST routes for signals/positions/trades return `id: result.lastInsertRowid` but the async DB returns `{id}`/`{changes}` (SQLite-era shim) → `id: undefined` in responses.
6. `AutomationState.getAll()`/`Settings.getAll()` return {} on KV (no prefix listing) — any rebuild UI must fetch known keys individually (as /api/settings does with SETTINGS_KEYS).
7. `cyclesPerRun` lives only in client-saved automation_settings (server default 1, cap 10; validated `>= 1` number in run-cycle). Not in server defaults merge → cron uses 1 until the user saves settings once from the UI.
8. `htfConfirmationSource` is stored INSIDE marketSignalSettings (not the standalone SETTINGS_KEYS.htfSource key, which is never written).
9. `automation_symbols` is written at cycle START (lastCycleTime, real KV write) and at run-cycle END (final symbols incl. errorCount/status) — two writes per call; the in-between 'waiting' status flips are in-memory only (audit-1 gotcha #2 still true).
10. Frontend persistence chain for settings: localStorage (cache) + `automationState:automation_settings` + mirrored strategy params into `automationState:marketSignalSettings` (dual-key duplication by design — Task 19); Bale creds canonical in marketSignalSettings via settings.html.
11. localStorage keys in play: `marketSignalSettings`, `automation_settings`, `automation_symbols`, per-symbol `automation_market_/automation_signals_/automation_history_${symbol}`; sessionStorage (dashboard→trading handoff): `signals`, `metadata`, `historyData`.
12. Logs dedupe on read: key = `${created_at}|${message}` (logs route merge of shared logs + lastCycleLogs).


---
Task ID: design-1
Agent: main-orchestrator
Task: معماری نسخه جدید TradeBot

## Architecture Decisions (v2 — rebuilt from audit)

### Environment adaptation (sandbox)
- Single-page app at `/` (src/app/page.tsx) with client-side views: داشبورد / اتوماسیون / چارت / تنظیمات + login gate
- API routes under src/app/api/** (Node runtime, no edge needed in sandbox; edge-compatible code paths kept pure)
- Storage: `StorageInterface` (KV semantics) + LocalAdapter (db/trading_data.json file, KV-like get/put/list) + KVAdapter (Cloudflare binding) + WriteBatcher (change detection) + budget counters
- Toobit public endpoints (klines/ticker) are LIVE (internet OK); signed endpoints run in DEMO mode when no API keys configured: DemoState persisted in storage (demo:* keys) simulates balance/positions/orders with REAL price data, TP/SL auto-close simulation
- Auth: session cookie (HMAC-SHA256, AUTH_SECRET env w/ dev fallback), salted SHA-256 password, demo credentials admin/admin shown on login page (test env only); ALL sensitive API routes authed

### Source layout
- src/core/ — pure computation: types, indicators (RSI fixed alignment, ATR, SMA), strategy (daily levels w/ Tehran midnight, fake-breakout SM), signals (gen+TP/SL+status+stable IDs), risk (6 controls+margin), time (closed-candle detection)
- src/server/ — storage/, exchanges/toobit/ (client+endpoints+signing+demo), automation/ (cycle-engine+context+lock+result), auth/, notifications/bale, observability
- src/app/api/ — automation/(run-cycle,status,symbols), market/(klines,analysis,ticker), positions/(open,close), account/balance, settings(+test-bale), diagnostics/(logs,storage,history), auth/*, internal/cron
- src/modules/ — React UI: layout (Sidebar/Header), common (cards/badges/toasts), automation panels, chart, settings
- Theme: dashboard.html tokens → globals.css (CSS vars, [data-theme=dark]), Vazirmatn CDN font, Phosphor icons npm, indigo accent per user's chosen theme

### Regressions/fixes vs reference (documented, per instruction §5/§8)
1. RSI off-by-one FIXED (length-N aligned array) — documented in code
2. Explicit closed-candle filter (openTime+interval ≤ now) — no last-index hacks
3. HTF confirmation: signalCandleClose default (no dashboard lookahead variant)
4. No hardcoded keys anywhere; settings GET redacts keys
5. Cycle lock (TTL-based) prevents cron+manual overlap
6. Order flow: TP/SL failure surfaced as WARNING in cycle result (not silent)
7. Stable signalId: SYMBOL_SIDE_candleOpenTime_ms_v1; clientOrderId from it (idempotency)
8. Separate timestamps: candleOpenTime/candleCloseTime/signalConfirmedAt/executionRequestedAt/orderSubmittedAt/filledAt
9. Auth on all trade/settings/db routes
10. Stats computed from historyPositions (real source), not dead trades array

### KV write budget (target)
- Cycle: 1 write `symbols` (lock+lastCycleTime) + 1 write `lastCycleResult` + 1 batched `logs` append + occasional `demo:*` in demo mode = ~3 writes/cycle → 864/day at */5 cron — same as reference budget
---
Task ID: impl-chart
Agent: chart-builder
Task: professional chart view (src/modules/chart) — full E2E-verified implementation

## Work Log
1. Reviewed existing chart module state (ChartView.tsx, ChartToolbar.tsx, types.ts, chartTheme.ts, drawingRender.ts) — prior skeleton existed; hardened + fixed it to full spec.
2. FIX (critical, runtime): overlay `<canvas>` is a replaced element — `position:absolute; inset:0` from `.chart-canvas-overlay` leaves it at intrinsic 300×150 (verified in headless Chromium: overlay box was 300×150 instead of 1570×583, click/draw only worked in top corner). Added inline `width:'100%', height:'100%'` → overlay now fills chart-wrap in both light/dark harness.
3. ChartToolbar: replaced symbol `<select>` with spec-required symbol CHIPS (BTC/ETH/DOT/SOL/BNB/XRP/DOGE/ADA/AVAX/LINK) — pill-styled via `.tool-btn` class + inline overrides (theme-aware incl. dark active color #a5b4fc); external symbol (from onGoChart) renders as extra active chip; tooltips + aria labels kept Persian.
4. ChartView: removed leftover debug console.log + stale eslint-disable (lint warning); legend (O/H/L/C/V/RSI) now monospace per spec.
5. types.ts: added optional `signalCloseTime` to Signal (API contract parity).
6. Browser E2E (bun-build harness in /tmp + agent-browser headless, fetch stubbed with 500 synthetic candles/signals/pending/ticker):
   - 10 chips render, BTC active; ETH click switches + onSymbolChange fires; 30m/4h interval seg works.
   - 8 lightweight-charts canvases; candles up #10b981 / down #ef4444 pixel-verified; blue solid Entry price line pixel-verified (TP/SL dashed share candle colors).
   - Signal panel: «سیگنال‌های اخیر» 2 signals + status badges; pending marker enlarged «L · در انتظار».
   - Live price pill shows ticker price (59,150.01).
   - Drawing tools (real mouse events): hline 1-click (3854 accent px), trend 2-click + move preview (5054 px), vline full-height after resize, measure 2-click → floating Δ/٪/candles box (4242 dark-box px), delete-last removes last, clear-all → overlay fully transparent.
   - Theme flip data-theme→dark: MutationObserver re-applied palette (713k dark-bg px on chart canvas), zero page errors.
   - Resize 1600→1100 viewport: ResizeObserver + rAF watchdog re-fit chart & overlay (1070×453).
   - Error path: broken fetch → Persian error card + «تلاش مجدد» retry → recovers.
   - Esc cancel + pointer-events gating verified via style toggling ('none' default / 'auto' when tool active).
7. Cleanup: harness entry deleted from repo, test server/browser closed; deliverable = 5 files in src/modules/chart only.

## Stage Summary
- Deliverable: `src/modules/chart/{ChartView.tsx (915L), ChartToolbar.tsx (chips UI), types.ts (API+drawing types), chartTheme.ts (CSS-var palette bridge), drawingRender.ts (canvas renderer)}` — `ChartView` props `{ initialSymbol, onSymbolChange? }`, integrated in `src/app/page.tsx` (view=chart).
- All 10 required features implemented; drawings stored in LOGICAL coords (time+price), redraw on pan/zoom/resize/theme/data via subscribeVisibleLogicalRangeChange + ResizeObserver + MutationObserver + rAF signature watchdog; full unmount cleanup (chart.remove, observers, intervals, rAF).
- Verification: `tsc --noEmit` → 0 chart-module errors; `bun run lint` → 0 chart issues (remaining repo errors are in other agents' files: AppHeader.tsx, settings-service.ts, kv-adapter.ts, plus page 500 until dashboard/automation/settings modules land).
- Known env note: dev :3000 currently 500s on missing sibling modules (@/modules/automation|dashboard|settings) — outside chart scope; chart module compiles clean standalone (bun build 24 modules OK) and is browser-verified.

---
Task ID: impl-main
Agent: main-orchestrator
Task: پیاده‌سازی کامل نسخه جدید TradeBot v2

Work Log:
- Core محاسباتی: types، settings (پیش‌فرض‌های مرجع)، RSI (اصلاح هم‌ترازی)، ATR، SMA، سطوح روزانه تهران، ماشین حالت Fake Breakout + حالت legacy، مولد سیگنال + TP/SL، وضعیت سیگنال، ۶ کنترل ریسک، تشخیص کندل بسته صریح
- Server: StorageInterface + LocalAdapter (db/trading_data.json، صف سریال، شمارنده R/W) + KVAdapter + WriteBatcher (diff ساختاری)؛ ToobitClient واحد (۹ endpoint، امضای HMAC، timeout 12s، نرمال‌سازی پاسخ) + DemoEngine (شبیه‌سازی حساب/سفارش/TP-SL با قیمت واقعی و بستن خودکار)؛ Session auth (کوکی HMAC + رمز شور‌دار + ابطال نشست)؛ Bale (ارسال + صف معوق ۵۰)
- Cycle Engine واحد: ۱۴ مرحله، قفل TTL 90s، context تجمیعی، persist واحد در پایان، تفکیک زمان‌ها، شناسه پایدار سیگنال، گزارش شکست TP/SL، رد ریسک با قیاس ریاضی بله
- API: auth(4) + automation(run-cycle/status/symbols) + market(klines/analysis/ticker) + positions(open/close) + account/balance + settings(+test-bale) + diagnostics(logs/storage/history) + internal/cron — همه با requireAuth (کرون با X-Cron-Secret)
- Frontend: تم dashboard.html به globals.css منتقل شد (توکن‌ها، کارت‌ها، سایدبار RTL، مودال‌ها، توست‌ها، ریسپانسیو)؛ Vazirmatn CDN + Phosphor npm؛ SPA با ۴ نما + دروازه ورود؛ نمای اتوماسیون با ۶ پنل مستقل و به‌روزرسانی وابسته؛ داشبورد با KPI + جداول؛ تنظیمات ۳ تب (۷ گروه استراتژی)؛ چارت حرفه‌ای توسط عامل chart-builder (کاندل + حجم + مارکر سیگنال + TP/SL + ۶ ابزار رسم + تم دوگانه)
- مستندات: docs/{architecture, security, storage-write-budget, exchange-api-catalog, cycle-lifecycle, testing-and-deployment}.md
- cloudflare/scheduler: کرون‌ورکر */5 → /api/internal/cron

Stage Summary:
- tsc: 0 خطای src · lint: 0 خطا · dev server: بدون خطا
- تست واقعی: ورود ✓ نمادها ✓ موجودی دمو ۱۰۰۰۰ ✓ کندل واقعی توبیت ✓ چرخه از UI (۶ مرحله، سیگنال منقضی = رفتار صحیح) ✓ جریان سفارش دمو (باز/بست/TP-SL/PnL زنده) ✓
- مرورگر (agent-browser + VLM): داشبورد/چارت/تنظیمات/اتوماسیون رندر ✓ تم روشن/تاریک ✓ موبایل 390px (فوتر sticky، بدون سرریز) ✓ رسم خط افقی + حذف ✓ صفر خطای کنسول ✓
- حالت آزمایشی: بدون کلید API → بازار واقعی + حساب شبیه‌سازی؛ با کلید → اتصال زنده توبیت

---
Task ID: fix-storage-adapter
Agent: main-orchestrator
Task: رفع خطای build «Module not found: Can't resolve './local-adapter'» (گزارش کاربر — پیشنمایش اجرا نمی‌شد)

Work Log:
- ریشه‌یابی: src/server/storage/index.ts ماژول './local-adapter' را import می‌کرد ولی فایل src/server/storage/local-adapter.ts هرگز روی دیسک نوشته نشده بود (entry قبلی worklog §impl-main آن را توصیف کرده اما فایل جا مانده بود). فایل داده db/trading_data.json موجود بود.
- ساخت src/server/storage/local-adapter.ts با کلاس LocalKVAdapter (پیاده‌سازی کامل KVStore):
  * بارگذاری تنبل نقشه KV از db/trading_data.json + مسیر قابل‌تنظیم با TB_DATA_FILE/TRADING_DATA_FILE (رفع باگ DB_PATH مطلق پروژه مرجع، audit §F.2)
  * صف سریال نوشتن (promise chain) — همه put/delete از طریق یک زنجیره سریال flush می‌شوند؛ رقابت read-modify-write ممکن نیست نوشتن را گم کند
  * نوشتن اتمیک: tmp + rename — خرابی فایل در کرش میانی غیرممکن
  * deep-clone در get/put — فراخوان نمی‌تواند cache را درجا تغییر دهد (تشخیص تغییر WriteBatcher سالم می‌ماند)
  * شمارنده بودجه منطقی (get/list=خواندن، put/delete=نوشتن) — هم‌ارز CloudflareKVAdapter برای قیاس diagnostics
- راستی‌آزمایی: tsc → ۰ خطای src · lint → ۰ خطا · GET / → 200 · /api/auth/verify → 401 درست (نه 500)
- تست مرورگر کامل (agent-browser): ورود admin/admin123 (اعتبارنامه persisted از جلسه قبل) ✓ داشبورد KPI ✓ نماهای اتوماسیون/چارت/تنظیمات ✓ داده بازار واقعی توبیت (klines/ticker/analysis 200) ✓
- اجرای یک چرخه از UI: POST /api/automation/run-cycle → 200؛ بودجه ۴ نوشتن (مطابق هدف سند ۳-۵)؛ فایل JSON سالم و lastCycleResult (DOT، SIGNAL_EXPIRED، ۶ مرحله) persisted شد
- تشخیص بودجه از /api/diagnostics/storage در طول چرخه کار کرد؛ صفر خطای کنسول/صفحه؛ تم تاریک ✓؛ موبایل 390px فوتر sticky پایین ✓

Stage Summary:
- فایل ساخته‌شده: src/server/storage/local-adapter.ts — تنها فایل تغییریافته؛ هیچ رگرسیونی در بقیه پروژه
- پیشنمایش کاربر کاملاً بازیابی شد: صفحه اصلی 200، ورود، داشبورد، چرخه معاملاتی، بودجه ذخیره‌سازی و همه APIها سالم
- نکته: اعتبارنامه ورود فعلی admin/admin123 است (در حافظه پایدار از تست قبلی؛ با صفحه تنظیمات قابل تغییر)

---
Task ID: fix-instability + github-repo
Agent: main-orchestrator
Task: ریشه‌یابی ناپایداری خطای local-adapter + ساخت repo عمومی TradeBot-Production-V2

Work Log:
- ریشه‌یابی حذف مکرر: .gitignore خط ۴۳ الگوی `local-*` داشت → src/server/storage/local-adapter.ts از همه‌ی checkpoint های خودکار سندباکس (commit های UUID در 21:36 و 02:35) مستثنا می‌شد؛ هر restore/ری‌بوت سندباکس (آخرین: امروز 05:51 — مطابق mtime پوشه) فایل را پاک می‌کرد → خطای Module not found بازمی‌گشت. فایل track شده (مثل kv-adapter.ts از 21:25) جان سالم می‌برد.
- رفع ریشه‌ای: حذف الگوی `local-*` (و `test`) از .gitignore؛ بازسازی local-adapter.ts با کامنت هشدار ماندگاری؛ commit واقعی (f2262c7) → از این پس فایل در checkpoint ها هست و restore ها آن را نگه می‌دارند.
- پاک‌سازی: untrack شد tool-results/ (۱۶ فایل آرتیفکت داخلی) و .zscripts/dev.pid؛ الگوهایشان به .gitignore اضافه شد.
- راستی‌آزمایی: /api/auth/verify → 401 درست، GET / → 200، ورود admin/admin123 ✓، چرخه از UI → ۳۱ خواندن/۴ نوشتن، JSON سالم ✓، صفر خطای کنسول.
- README.md جامع (فارسی) برای repo ساخته شد: امکانات، راه‌اندازی، متغیرهای env، ساختار، استقرار Cloudflare، لینک مستندات.

Stage Summary:
- ناپایداری به‌طور ریشه‌ای حل شد (نه فقط علامت‌زدایی): الگوی خطرناک gitignore حذف + فایل committed → از این پس restart سندباکس خطا را بازنمی‌گرداند
- repo عمومی github.com/<owner>/TradeBot-Production-V2 با کل سورس push شد (تاریخ commit های checkpoint سندباکس حفظ شد)

---
Task ID: chart-upgrade-1
Agent: main-orchestrator
Task: ۴ خواسته‌ی چارت — ویرایش رسم‌ها (گره+رنگ)، کادر سیگنال auto-size، نماد دلخواه، اصلاح ابزار اندازه‌گیری (LTR + ریشه‌یابی ٪)

Work Log:
- تحلیل کامل قبل از پیاده‌سازی (لیست منظم ارائه شد به کاربر):
  ۱) ویرایش رسم: انتخاب با کلیک (حالت عادی) روی wrap با onPointerDownCapture (نه mousedown — lightweight-charts با pointer events پن می‌کند) + stopPropagation؛ hitTestDrawing با اولویت دستگیره (۹px) روی بدنه (۷px)؛ درگ گره با مگنت، درگ بدنه با آفست منطقی (hline=قیمت، vline=زمان، دوعضوی=انتقال، مستطیل=۴ گوشه)؛ پنل ویرایش ۸ رنگ + حذف انتخابی + Esc لغو درگ/انتخاب + Delete حذف؛ بازخورد کرسر با data-dhover (CSS !important بر کرسر خود کتابخانه)؛ رنگ در Drawing.color + lastColor پیش‌فرض رسم بعدی
  ۲) کادر سیگنال: width 250px ثابت → max-content + min/maxWidth + flexWrap سطرها — دیگر هیچ محتوایی بریده نمی‌شود
  ۳) نماد دلخواه: دکمه + → ورودی LTR با اعتبارسنجی ^[A-Z0-9]{2,16}$، چیپ خط‌چین + × حذف، localStorage (tradebot.chart.customSymbols، سقف ۱۶)، سوییچ خودکار به نماد جدید؛ سرور بدون لیست سفید بود (هر SYMBOL-SWAP-USDT)
  ۴) اندازه‌گیری: کادر کامل بازنویسی LTR (direction ltr، textAlign left، ارقام لاتین، فونت monospace) + خط‌های From/To/Δ/Δ%/Bars/Span برای قابلیت راستی‌آزمایی
- ریشه‌یابی ٪ ۸.۲ vs ۴.۶۳: فرمول کد = دقیقا فرمول TV ((p2−p1)/p1×100) ✓؛ نگاشت فیلد کندل Toobit خام ([t,o,h,l,c,v]) با اعتبارسنجی OHLC ✓؛ فید داده Toobit vs Binance بر ۴ نماد (اختلاف <۰.۱۵٪) ✓ → فرمول و داده سالم؛ باقی‌مانده دقت ثبت نقطه‌ی کلیک بود → مگنت اضافه شد: نزدیک ۸px نوک سقف/کف، قیمت دقیقا به high/low کندل snap می‌شود
- E2E مرورگر (agent-browser + VLM): ثبت اندازه‌گیری بین کف 80,629.5 و سقف 82,886.9 با کلیک پیکسلی دقیق → drawings() دقیقا همان قیمت‌ها (مگنت ✓) → VLM خواند کادر: From 80,629.5 / To 82,886.9 / Δ +2,257.4 / Δ% +2.8% / Bars 10 / Span 10 ساعت — LTR ✓ ارقام لاتین ✓ و ۲.۸۰٪ = محاسبه دقیق TV ✓
- درگ گره دوم به کندل دیگر → time2/price2 دقیقا سقف آن کندل (۸۲۷۶۳.۲) ✓؛ رنگ قرمز → VLM تایید ✓؛ Esc=بستن پنل ✓؛ Delete=حذف ✓؛ LTC اضافه شد (چیپ + localStorage [\"LTC\"] + ۵۰۰ کندل واقعی ~$70.8) ✓؛ حذف چیپ ✓؛ سوییچ BTC محو چیپ ✓
- کادر سیگنال: max-content، scrollWidth==clientWidth (صفر برش)، موبایل 390px جا شد ✓؛ تم تاریک + خط قرمز + پنل با VLM تایید ✓؛ صفر خطای کنسول/صفحه
- tsc ۰ خطا · lint ۰ خطا

Stage Summary:
- ۵ فایل تغییر یافت: types.ts (+color/DRAW_COLORS)، drawingRender.ts (رنگ، دستگیره، hit-test، کادر LTR)، ChartToolbar.tsx (نماد دلخواه)، ChartView.tsx (انتخاب/درگ/مگنت/پنل ویرایش/auto-size/localStorage/debug hook)، globals.css (کرسر)
- ابزار اندازه‌گیری اکنون ریاضیاتی قابل اثبات است: قیمت هر دو نقطه در کادر نمایش داده می‌شود و با مگنت همیشه دقیقا روی نوک کندوک قفل می‌شود

---
Task ID: mission2-analysis
Agent: main (Z.ai)
Task: Full audit for 10-phase fix mission (Phases 0-9) — research only, no code written yet

Work Log:
- Read all UI files: AutomationView.tsx (769L), globals.css (1266L), page.tsx, AppHeader.tsx, Sidebar.tsx, DashboardView.tsx (400L), layout.tsx, LoginView (demo hint line)
- Read server files: cycle-engine.ts (514L), cycle-context.ts, toobit client/endpoints/demo, storage index/interface, settings-service, all API routes (status/run-cycle/cron/logs/history/balance/positions/symbols/market)
- Verified PnL contract against OFFICIAL Toobit docs (api-docs.toobit.com rendered via agent-browser):
  * GET /api/v1/futures/positions fields: symbol, side, avgPrice, position(contracts), available, leverage, lastPrice, positionValue, flp, margin, marginRate("0.4992" for 2x => FRACTION), unrealizedPnL(USDT), profitRate("Profit rate", fraction), realizedPnL, maxNotionalValue, marginType, markPrice
  * WS account stream sample: up:"12" (unrealizedPnL), pr:"0.003" (profitRate) => FRACTION confirmed
  * GET historyPositions: realizedPnl("1000"), realizedPnlRate("0.0042") => FRACTION, openAvgPrice/closeAvgPrice (NOT avgPrice), openTime/closeTime, id
  * GET futures/balance: coin, balance, availableBalance, positionMargin, orderMargin, crossUnRealizedPnl, coupon
- Cross-checked OLD reference repo (drvesali1374-ai/TradeBot-Production clone): `parseFloat(pos.profitRate||0)*100` then `.toFixed(2)%` => profitRate consumed as FRACTION x100
- BUG CONFIRMED: v2 getOpenPositions passes raw fraction to fmtPct (percent-units) => 100x error. Also entryPrice in historyPositions maps wrong field (avgPrice vs openAvgPrice). checkClosedPositionsHistory Bale message shows raw realizedPnlRate as % (no x100).
- Phase 0 findings: .env + db/custom.db + db/trading_data.json ALL TRACKED in git since initial commit b982685 (pushed to GitHub!). trading_data.json contains REAL apiKey(64)/secretKey(64)/baleToken(45)/baleChatId + auth hashes. custom.db = leftover prisma scaffold (User/Post, no secrets). .env has DATABASE_URL only. Secrets present in ALL 6 commits => history purge required.
- Mobile menu: CSS layering looks correct (sidebar z:100 > backdrop z:99; translateX(100%) hidden / translateX(0) open at <=1024px) => must live-test to root-cause user's invisibility report
- Sticky: .top-header has NO sticky positioning; unscoped th/td rules (globals.css 605-621) violate user requirement; .view-enter uses slideUp with fill-mode both (potential sticky-breaking ancestor transform)
- Log system: persistCycleOutcome maps ONLY result.logs (3-5 entries) to LogRecords with action:'automation_cycle' for ALL; result.steps (14 steps, rich data: risk controls, orderId, durations) never persisted => Phase 2 core gap
- No PAT token on disk (needed for final push; will request or user must provide)
- Data model changes planned: LogRecord + process/source/durationMs fields (backward-compatible UI fallbacks); CycleResult.demo removed; OpenPosition numeric fields become nullable (null=نامشخص, no fake zeros)

Stage Summary:
- Complete Phase 0-9 checklist registered in session todos (21 items); evidence-based PnL unit contract established (fraction, x100 for display, single conversion point in ToobitClient.getOpenPositions); execution order: 0(security) -> 7(dashboard removal) -> 6(demo removal) -> 1(tables+PnL) -> 2(log table) -> 3(symbol card+RTL) -> 4(widths) -> 5(header+menu) -> 8(build) -> 9(acceptance+report) -> github push

---
Task ID: mission2-exec
Agent: main (Z.ai)
Task: Execute 10-phase fix mission (Phases 0-9) on TradeBot-Production-V2

Work Log:
- Phase 0 (security): safe backup (/home/z/tb-backup: bundle + file copies, 0700); git filter-branch purged .env + db/trading_data.json + db/custom.db from ALL history (real apiKey/secretKey/baleToken were exposed since initial commit); refs/original deleted + reflog expired + gc --prune=now; verified ZERO sensitive objects remain (only trading_data.example.json fixture); .gitignore += /db/*.json, /db/*.db, *.sqlite + !.env.example/!example fixture negations; committed .env.example + db/trading_data.example.json + tests/fixtures/toobit-positions.sample.json (all fake values); runtime files restored from backup and remain on disk untracked
- Phases 6+7: demo.ts DELETED; ToobitClient requireCredentials() gate → NO_CREDENTIALS («اعتبارنامه صرافی تنظیم نشده است») on every account/order op; hasCredentials replaces mode; CycleResult.demo removed; cycle engine logs a warning step when creds missing; notifications drop demo strings; all UI demo badges/states removed (cycle pill, balance pill, sidebar Demo badge, user-plan, footer, login hint reworded to setup-guide); diagnostics/history no demoEngine; storage demoState key removed; DashboardView.tsx DELETED; ViewId = automation|chart|settings; default view automation; «یک چرخه» gated to automation only
- Phase 1 (PnL): official Toobit docs verified live via agent-browser (positions: unrealizedPnL/profitRate fraction; historyPositions: realizedPnlRate "0.0042" fraction + openAvgPrice; balance: crossUnRealizedPnl) + old repo used ×100 → normalizePosition/normalizeHistoryPosition are the SINGLE reference converters (fraction→percent internal contract, strict toNum: missing/invalid/empty→null); positions qty/margin/etc nullable; controls.ts PRICE_DISTANCE handles null entry honestly («قابل ارزیابی نیست»); historyPnl entryPrice maps openAvgPrice; fmtUsd stable 2-decimals; fmtPct contract documented; scoped table CSS under .tb-table (sticky thead z5 opaque, border-collapse separate + spacing 0, uniform row lines); shared DataTable component (single real table, colgroup, per-type alignment, LTR-isolated cells, expandable rows)
- Phase 2 (logs): persistCycleOutcome maps ALL steps → LogRecords (process names, STEP_TO_LOG_STATUS: ok/info/skipped/warning/failed→SUCCESS/INFO/SKIPPED/WARNING/ERROR, durationMs, step, sanitized details — secret-key regex strip) written in ONE put (2 puts/cycle total); LogRecord extended (process/source/durationMs/step, details object-or-string, backward-compat fallbacks); ctx.log() removed (steps are the canonical stream — no double registration); log table = FULL-width section with search + symbol/status/cycleId filters + expandable technical details + copy cycleId (clipboard API + execCommand fallback + id-in-toast graceful degradation) + funnel-filter by cycle; cycleId removed from summary badges → execution details; steps kept as expandable «جزئیات اجرا»
- Phase 3: kpi-grid 5-column with kpi-symbol FIRST card (accent, 21px isolated LTR name, mobile spans full row); ready-signal rebuilt as signal-meta chips (each label+value = isolated LTR bdi unit, wraps BETWEEN units — no overlap/reorder)
- Phase 4: content-grid = minmax(0,1fr) + minmax(360,380) → verified 714/380 at 1440; log table outside grid full-width (952=952 verified); symbols table minWidth 320→430
- Phase 5: .top-header sticky top:0 z80 opaque bg + full-bleed via --content-pad-x var (28/18/12px per breakpoint); sidebar z 100→110 > backdrop 99; backdrop blur REMOVED (dim only); body.nav-drawer-open scroll lock; ROOT-CAUSED toggle-on-desktop bug (.icon-btn display:flex appeared AFTER .mobile-toggle display:none in source order — same specificity) → .icon-btn.mobile-toggle selectors
- Phase 8: next.config.ts standalone + ignoreBuildErrors REMOVED (tsc actually clean); package.json build=next build, build:pages=@cloudflare/next-on-pages, test:pnl; tsconfig scoped to src/ (examples/skills/tests/cloudflare have own toolchains); README + docs aligned (PnL contract section, log table section, single build path, no-demo wording)
- Verification: tsc --noEmit 0 errors; eslint 0; agent-browser E2E: sticky header all 3 views (rect top=0 after scroll), drawer opens (rect left=118 visibleOnScreen, z110>99) + closes (Escape/backdrop/nav), toggle hidden@1440 + flex@390, log thead sticky (th top==container top, rows scroll under), filters (status WARNING=11 rows, search «منقضی»=11, cycleId funnel), expandable details (labels + kv + cycleId + copy), symbols/positions/signals tables at minWidths with scroll; manual cycle on all-NO_SIGNAL symbols (provably safe, zero signed calls) → REAL step records: بارگذاری تنظیمات/قفل اجرا/انتخاب نماد/داده بازار/محاسبات و سیگنال/انتخاب سیگنال + result SIGNAL_EXPIRED; storage budget 23 reads/5 writes (aggregate log write=1); tests/pnl-mapping.test.ts ALL PASS (7 fixture cases + display contract 0.003→+0.3٪ + $12.50 + «—» for missing + sign consistency); VLM desktop audit 6/6 PASS, VLM mobile: no overlap/cutoff, drawer fully visible above dim; console zero errors

Stage Summary:
- 5 commits: 1fd922f (phase-0 security) → e5e6ef8 (phases 1-7 core) → 32e10be (toNum/fmtUsd/toggle fixes + pnl test) → c5f1d89 (phase-8 build/docs) → latest (clipboard fallback)
- Deliverables: secret-free history; single PnL contract (fraction→percent, null=نامشخص); unified real-event log table (aggregated KV writes, filterable, copyable cycleId); symbol card; RTL signal chips; sticky header everywhere; working mobile drawer; dashboard+demo fully removed; one official build path (Cloudflare Pages + cron worker)
- GitHub push pending: PAT token not present in this session — must be provided by owner; force-push required (history rewrite)

---
Task ID: git-sync
Agent: orchestrator (main session)
Task: Push final project state to GitHub repo TradeBot-Production-V2 — replace remote (older parallel-session history) with local final state per owner instruction + provided PAT.

Work Log:
- Compared local main (top: e154f05 docs(phase-9) 2026-10-20 12:52) vs origin/main after fetch (top: 464a939 feat(chart) 2026-10-19 07:31, force-pushed by a parallel sandbox session)
- Verified chart module identical between both trees (diff --stat empty) → local is strict superset: phases 0-9 + delivery report + tests + secret-free history
- Found remote tracks .env (secret leak) → replacement removes it from HEAD
- Secret scan on local tracked files: clean (no github_pat, no .env tracked)
- Force-pushed local main to origin/main (owner explicitly requested replacing old files with new ones)

---
Task ID: m3-audit-v2
Agent: v2-auditor
Task: Mission-3 deep audit of V2 current state (data paths, gaps vs mission)

Work Log (verified in code at 66842e8 = main = mission/v2-fixes; tsc clean; pnl test 15/15 PASS):
- Toobit: client.ts fully live-only (NO_CREDENTIALS gate, HMAC sorted-QS signing, 12s timeouts). Endpoints: /quote/v1/klines, /quote/v1/ticker/price, /api/v1/futures/{balance,positions,historyPositions,userTrades,leverage,order,position/trading-stop}. normalizePosition maps profitRate fraction→percent ONCE; TP/SL hard-coded null (client.ts:343-346) → positions TP/SL column always «—». getUserTrades dead code (never called). closePosition = POST order SELL_CLOSE/BUY_CLOSE, success = HTTP-ok only (no orderId echo check).
- Types: OpenPosition all-nullable + takeProfit?/stopLoss?; ClosedPosition realizedPnl/Rate percent; LogRecord {process,source,durationMs,step,cycleId,details} + LogStatus union SUCCESS/INFO/SKIPPED/WARNING/ERROR; StepStatus ok/info/skipped/warning/failed.
- Engine: runCycle 14 steps in ctx.steps (in-memory), persistCycleOutcome (caller-side) maps ALL steps→LogRecords (sanitized secret-key regex, ONE logs put + lastCycleResult put; LOGS_CAP 500; ids renumbered each cycle). STEP_TO_LOG_STATUS at cycle-engine.ts:427. Cycle summary = single KV key lastCycleResult (overwritten).
- API (all auth-gated except auth/*, cron(secret), /api hello): positions/open GET, positions/close POST {symbol,direction}→{success,closed,total,errors}; run-cycle POST(+GET!); diagnostics/logs?limit≤200 (UI asks 200); diagnostics/history (closed+stats {total,winning,losing,totalPnl} — NOT consumed by any UI); NO per-symbol stats endpoint. Cron route reads CRON_SECRET but .env.example says X_CRON_SECRET and worker sends RUN_CYCLE_SECRET — naming mismatch.
- AutomationView: close button fires POST immediately, NO confirm dialog (line ~653); PnL cell = fmtUsd(unrealizedPnL)+fmtPct(profitRate), null→«—», pnlColor sign-aware; TP/SL reads p.takeProfit/p.stopLoss (always null) → empty; log table = separate full-width section, filters search/symbol/status/cycleId-funnel, expandable row + copy cycleId; symbols table in side-panel col (grid minmax(360,380)) but minWidth=430 → guaranteed h-scroll; data fetched ONLY on mount/refreshKey — no polling anywhere in automation view.
- format.ts: fmtDateTime = fa-IR month/day «،» HH:mm, fmtTime = fa-IR HH:mm:ss — NO explicit timeZone → browser-local (not Tehran), no year, mixed with toISOString UTC in Bale messages; Persian digits only via fa-IR locale; numerals Latin (en-US) elsewhere; no toPersianDigits helper.
- Fonts: CDN <link> jsdelivr Vazirmatn v33.003 (layout.tsx:31-34); font-family 'Vazirmatn' (globals.css:118,743; chartTheme.ts:64; drawingRender.ts:225); ZERO font files in public/; no next/font — offline/IR-blocked → system fallback.
- Chart: state-only symbol/interval (no URL params); klines limit=500 fixed, no back-pagination; signals as lightweight-charts markers (createSeriesMarkers) + Entry/TP/SL price lines for pending; initial visible range = last 130 bars (ChartView.tsx:467) — NO focus-timestamp mechanism exists; onGoChart passes symbol only.
- Tests: bun run tests/pnl-mapping.test.ts (15 checks, all pass, fixtures sanitized); no other tests; scripts: build/next, lint, build:pages, test:pnl.
- Auth: HMAC-signed cookie tb_session, salted SHA-256, first-login seeds admin when AUTH_ALLOW_SETUP=1 OR AUTH_SECRET unset; update-credentials bumps issuedAt (revokes others); NO middleware.ts — per-route requireAuth only.

Key gaps vs Mission-3 areas: close-confirm missing; PnL column OK (contract solid); TP/SL path dead (always null — needs exchange stop-order fetch or persisted order TP/SL join); cycle/log tables split (details expandable) — merge pending mission spec; time format local-tz/no-year/mixed-UTC; font CDN-only; chart-nav has no timestamp focus; no stats table (history endpoint unused); symbols table overflows 380px column; sidebar has hard-coded «کرون ابری active» row; no polling → stale PnL until manual refresh.
---
Task ID: m3-audit-ref
Agent: ref-auditor
Task: Mission-3 deep audit of TradeBot-Production reference (close flow, API contracts, TP/SL, PnL, signal logic)

# Audit m3 — V2-implementation contracts (all facts re-verified with file:line; builds on audit-1..4)

## 1. Close-position flow
- Client automation: automation-manager.js:2899-2912 POST /api/close-position, JSON body
  {symbol: BARE ("DOT"), direction: "long"|"short" (opposite of signal), clientOrderId: `${symbol}_close_${Date.now()}`,
   settings:{apiKey,secretKey,baseUrl}}. NO positionId / market / reduceOnly param. Pre-step GET /api/open-positions
  (2859-2865, headers X-API-Key/X-Secret-Key/X-Base-Url) captures closedPositionInfo {symbol,side,leverage,margin,
  unrealizedPnL,profitRate(=field×100),avgPrice,available} (2872-2891). Success check: only `response.ok` (2914),
  then `data.closed||0` (2917); errors swallowed → {closed:0} (2921-2924). No retCode parsing anywhere.
- Server route close-position/route.ts: keys body.settings→env→HARDCODED (12-14, DO NOT replicate); fullSymbol=`${symbol}-SWAP-USDT` (20);
  signed GET /api/v1/futures/positions?recvWindow=60000&ts&sig (23-37, X-BB-APIKEY); normalize array|data|result (40);
  filter posSymbol===fullSymbol.toUpperCase() && side==='LONG'|'SHORT' && parseFloat(pos.available||pos.position)>0 (43-52);
  none → HTTP200 {success:false,error:'No open positions found',closed:0,total:0} (54-56);
  per pos: side LONG→'SELL_CLOSE', SHORT→'BUY_CLOSE' (63); qty=Math.ceil(parseFloat(available||position)) (64-72);
  POST /api/v1/futures/order form-urlencoded sortedQS+sig: {symbol,side,type:'LIMIT',quantity,priceType:'MARKET',
  newClientOrderId:clientOrderId||`close_${Date.now()}_${i}`,timestamp,recvWindow:'60000'} (68-90);
  ok→closedCount++, else errors.push(text) (92-97); 300ms sleep if >1 (100-102);
  resp {success:closed>0, closed, total, errors?} (105-110); 500 on throw (111-114).
- Engine cycle-engine.ts:1205-1218: identical POST ${baseUrl}/api/close-position; checks only closeResponse.ok → closeData.closed.
- trading.html manual close: same endpoint, payload {symbol:settings.symbolName, direction, clientOrderId, settings} (trading.html:456-498).

## 2. Toobit contracts (all paths relative to baseUrl default https://api.toobit.com; header X-BB-APIKEY; ts=Date.now() ms)
- Public: GET /quote/v1/klines?symbol&interval&limit (toobit-proxy/route.ts:16, base hardcoded);
  GET /quote/v1/ticker/price?symbol= (create-position/route.ts:49) → priceData[0].p | .price|.p (51).
  Kline row (real sample in lib/tradebot/trading_data.json): [openTime,open,high,low,close,amount,0,value,count,f9,f10] — 11 elems.
- Signing (helpers.ts:15-50): sorted keys, encodeURIComponent both k+v, join '&'; HMAC-SHA256 hex (Web Crypto);
  GET: `?${qs}&signature=`; POST: body `${qs}&signature=` + Content-Type x-www-form-urlencoded. recvWindow 60000
  everywhere EXCEPT /api/v1/futures/positions via open-positions route (5000, open-positions/route.ts:24) and userTrades (5000).
- GET /api/v1/futures/positions (open-positions/route.ts:22-47) → {positions} passthrough. Consumed fields:
  symbol, side('LONG'|'SHORT'), posSide, available (qty in CONTRACTS), position (fallback), amount/positionAmt (fallback),
  margin (USDT), unrealizedPnL (USDT), profitRate (FRACTION; ×100 for % at automation-manager.js:2881,3379; engine:1189),
  leverage, avgPrice (entry price), markPrice (ONLY in getSymbolMargin fallback, automation-manager.js:3512),
  time|openTime|updateTime|createdTime (sort key 3347-3348). TP/SL fields: NEVER read — repo never accesses
  takeProfit/stopLoss/tpslMode/tpPrice/slPrice on a position record (grep-verified 0 hits).
- NO conditional/plan-order endpoint exists in the repo (no list/cancel of TP/SL orders). TP/SL only SET via
  POST /api/v1/futures/position/trading-stop (create-position/route.ts:96-126): params {symbol:full, side:'LONG'|'SHORT',
  timestamp, recvWindow:'60000', takeProfit?+tpTriggerBy:'CONTRACT_PRICE', stopLoss?+slTriggerBy:'CONTRACT_PRICE'};
  fire-and-forget (response ignored).
- POST /api/v1/futures/order (open): {symbol:full, side:'BUY_OPEN'|'SELL_OPEN', type:'LIMIT', quantity:intStr,
  priceType:'MARKET', newClientOrderId, timestamp, recvWindow:'60000'} (create-position/route.ts:60-70). NO price/positionSide/
  reduceOnly/attachAlgoOrders. Leverage: POST /api/v1/futures/leverage {symbol,leverage,ts,recvWindow} only if leverage>1,
  response ignored (23-46). Order error → {error:'Failed to create order',details} + upstream status (85-88); ok → {success:true,order} (128).
- Contract size: `const contractSize = 0.11` HARDCODED for ALL symbols (create-position/route.ts:54);
  notional = usdtAmount×(leverage||1) (55); quantity = Math.ceil(notional/(price×0.11)) — integer CONTRACTS (56-57).
  Close qty likewise ceil (close-position:72). avgPrice/available treated as price/qty in UI; margin approx
  (available×markPrice)/leverage only in getSymbolMargin (3510-3517).
- userTrades (fill history): internal POST /api/history → GET /api/v1/futures/userTrades — query built MANUALLY UNSORTED
  `symbol=&limit=&recvWindow=&timestamp=` (history/route.ts:23), sig covers exactly that; params top-level body
  {symbol:FULL, apiKey, secretKey, baseUrl, limit||'100', recvWindow||'5000'} (16-23); NO pagination (limit only).
  Fields consumed: time,symbol,price,qty,commission,side('BUY_OPEN'|'SELL_OPEN'|'BUY_CLOSE'|'SELL_CLOSE'),realizedPnl
  (automation-manager.js:2832-2840; engine:1036-1044).
- historyPositions (closed positions): GET /api/v1/futures/historyPositions?recvWindow=60000&ts&sig, NO symbol filter → ALL
  symbols (history-positions/route.ts:40-47). Fields consumed (engine checkClosedPositionsHistory 2037-2094): id, symbol,
  side('LONG'/'SHORT'), closeTime(ms), closeAvgPrice, realizedPnL, realizedPnlRate (ALREADY % — used directly, NO ×100;
  engine:2084-2088 vs open-pos profitRate which IS ×100), leverage. Sort closeTime DESC (2031-2035); dedupe vs KV
  lastPositionCloseTime by newest closeTime (2044-2053); notify first closedPositionsNotifyCount (default 10).
- Balance: GET /api/v1/futures/balance (balance/route.ts:22-29); 5-shape normalize (48-60); USDT by asset|coin|currency|symbol
  (63-66); total=balance|total, available=availableBalance|available (then free|availableBalance), positionMargin=positionMargin|
  position_margin, orderMargin=orderMargin|order_margin|frozen, unrealizedPnL=crossUnRealizedPnl|unrealizedPnl|unrealized (79-83);
  free=available−orderMargin (84); output .toFixed(4) strings + fetchedAt (86-95).
- Error convention: HTTP status + {error[,details]}; Toobit body passed as text in details; NEVER retCode/errMsg parsed.

## 3. Signal generation (automation-manager.js analyzeMarketData 690-1107 = trading logic; market-signal-analyzer.js 344-504 = legacy dashboard variant)
- Candle analyzed: loop `for(i=1;i<N-1;i++)` (850; analyzer:419) → last (forming) candle index N−1 EXCLUDED; most recent
  closed candle = index N−2. No explicit openTime check; full refetch each cycle (klines limit 1000, interval 1h).
- RSI (signal-utils.js:13-44, period 14, close): Wilder; seed simple avg at i===period; QUIRK off-by-one — array length N−1,
  rsi[k]=candle k+1's RSI (lookahead; forming candle RSI leaks into last analyzed candle). avgLoss=0 → rs=100 → RSI≈99.01.
  Thresholds: Long rsi[i]<rsiLongThreshold(30), Short rsi[i]>rsiShortThreshold(70) (949,981); dashboard single rsiThreshold
  (default 50): <50 Long, >50 Short (analyzer:429,436). Fallback chain rsiLong ?? marketSettings.rsiThreshold ?? 30.
- ATR (signal-utils.js:52-74, period 14): TR max(H−L,|H−pC|,|L−pC|); Wilder RMA seeded atr[0]=TR[0]; index-aligned.
- SMA: only volume — avgVols=SMA(amount,50) (778; analyzer:403). No price SMA in strategy.
- Daily levels: Tehran midnight, offset=3.5h (734); prevDailyHighs/Lows = prev day-in-data maxHigh/minLow, prevDayCloses (757-774).
- Fake breakout (default enableBreakLifecycleManagement=true, Wick, breakAtrMult L/S=0.20):
  breakLong: low[i] ≤ prevLow−atr[i]×0.20; breakShort: high[i] ≥ prevHigh+atr[i]×0.20 (821-827,878-884; Close method→close).
  SM (839-1013): expiry i−breakCandleIndex > (breakSequenceLifetime>0?that:lookback 50) (887-892); new break if !active||recovered
  (895-907); OPPOSITE break replaces (910-922); recovery Long close>prevLow / Short close<prevHigh (925-941, same-candle allowed);
  signal only on recovery candle (944); reset always (1012). Entry conds (946-950/978-982): avgVols≠null && amount>avgVols×volMult(0.2)
  && rsi cond && HTF (default signalCandleClose: close>prevLow / close<prevHigh, 856-859; previousDayClose variant 853-855;
  dashboard uses current-day lastClose = lookahead, analyzer:422-423). Legacy branch (SM off): crossover + recentBreak≤lookback (1021-1047).
- Entry price = signal candle CLOSE. TP/SL (954-995): Long tp=close+close×longFixedTp% else close+atr×20; sl=close−close×longFixedSl%
  else close−atr×6. Short tp=close−close×shortFixedTp% else close−atr×24; sl=close+close×shortFixedSl% else close+atr×4.
  DEFAULT QUIRK: shortFixedSl=6 (not null) → Short SL %-based by default (259; init-settings.js:23).
- Signal obj {type,timestamp=candle OPEN time,price,tp,sl,orderId=`${sym}_YYYYMMDD_HHMMSS` local tz (signal-utils.js:189-198),
  symbol,candleIndex} (965-975). Exchange order uses a FRESH id from Date.now() (3541).
- Expiry: (now−signalTime) > signalExpirationHours(6)h → 'منقضی شده' (1189-1197); only latest signal, only if never opened
  (1153-1160); selectedSignal = latest ONLY if status 'در انتظار' (1434). Engine identical (1056-1101) but returns literal
  'باز شده' instead of open-time string (engine:1095) — display-only diff.
- Duplicate detection: NONE — this.signals rebuilt from scratch each cycle (836); natural throttle = tradeWaitTime only.
- Sizing: margin = totalAssets×entryMarginPercent(5)%/100 toFixed(2) (3409-3412). CLIENT uses legacy settings.leverage (3538) &
  entryMarginPercent; SERVER engine uses direction-specific effLeverage/effEntryMarginPercent (engine:1125-1131,1471,1732)
  — CLIENT/SERVER DIVERGENCE (masked in practice: saveSettings mirrors Long values into legacy keys). qty = ceil(margin×lev/(price×0.11)) server-side.
- Opposite position: closed first (step 8) — ALL symbol positions opposite direction; close failure is NON-FATAL, still opens.
- 6 risk controls: (1) expiry (above); (2) minSameDirectionCandles>0 (2341-2434): candlesAfterSignal=len−sigIdx−1 (incl forming
  candle) must be ≥N and candles sigIdx+1..+N all green(Long)/red(Short); (3) safeAsset ALWAYS (2532-2555,3419-3423):
  free−newMargin ≥ total×50%; (4) priceDistance only if symbol∈freshOpenPositions AND lastEntry≠null (2569-2616): Long
  (last−cur)/last×100 ≥ 0.5%, Short (cur−last)/last×100 ≥ 0.5%; lastEntry = latest same-direction OPEN row price
  (getLastEntryPrice 3440-3475); (5) maxMargin same condition (2618-2644): posMargin+newMargin ≤ total×10%; (6) positiveMargin
  ALWAYS (2653-2672): max(newMargin,0)>0. All rejects → status waiting + lastCycleTime=now + errorCount=0 + Bale math notify.
- PnL: open positions NOT computed locally — exchange fields unrealizedPnL(USDT) & profitRate(×100→%) (3376-3398).
  Closed notify uses pre-close unrealizedPnL/profitRate (2880-2881); fill rows show realizedPnl sign-colored (1695-1744);
  closed-history notify uses realizedPnL + realizedPnlRate (already %, engine:2084-2088). No contract-size math in PnL display.

## 4. Cycle steps (client runCycle automation-manager.js:2223-2761)
0 selectNextSymbol (615-629: ready if !lastCycleTime||now−last ≥ tradeWaitTime×60000 min; first ready) + persist lastCycleTime=now
  immediately (2236-2237) → 1 setupForCycle clears all (2244,1202-1221) → 2 fetchMarketData (2248) → 3 updateVisualization→
  analyzeMarketData (2252) → 4 signals.length===0→NO_SIGNAL_GENERATED (2258) → 5 fetchPositionHistory (2267) → 6 render +
  updateSelectedSignal (2282-2289) → 7 no selectedSignal→skip (2292) → 8 fetchPrice (2310) → 9 closeOppositePositions (2320) →
  9.5 minSameDirCandles (2341) → 10 refresh history (2444) → 11 refresh openPositions + lastEntry cache (2460-2499) →
  12 fetchBalance (2508) → 13 newMargin (2528) → controls safeAsset/priceDistance/maxMargin/positiveMargin (2534-2672) →
  14 openPosition POST /api/create-position (2679-2685,3531-3548) → refresh balance (2692) → notifyOpenPosition Bale (2703) →
  saveAutomationData (2721). Loop interval 5min (3576-3578); run-once = cyclesPerRun sequential, 1s delay (4332-4349).
  Server /api/run-cycle: cyclesPerRun from KV (cap 10, def 1) + 1s delay (run-cycle/route.ts:76-113); cron auth X-Run-Cycle-Secret (44-53).
  Error path: errorCount++ → ≥allowedErrors(3) → reset+skip+Bale #عبور_نماد else status error+Bale #خطا (2741-2754).

## 5. Trade history / stats
- Local storage of history = CACHE only: KV keys history_{sym}, signals_{sym}, marketData_{sym}, processedData_{sym},
  selectedSignal_{sym} via dbSet (saveAutomationData 1829-1946, history at 1898-1915); global openPositions/balance caches
  (2497,2522,3008,3057). Canonical = exchange; trades/positions/signals KV collections have NO writers (stats dead).
- History endpoints: POST /api/history (userTrades per-symbol limit 100) for fills; GET /api/history-positions (ALL symbols)
  only by engine for closed-position notifications (engine:1996).
- Per-symbol stats: GET /api/db/stats/[symbol] → Analytics.getSymbolStats {symbol,total_trades,winning_trades,total_pnl,avg_pnl}
  from Trades collection ([symbol]/route.ts:6-19) — always zeros since Trades never written. No stats computed from exchange history.

## Key divergences/gotchas for V2
1. Client JS vs engine TS: effLeverage/effMargin (engine) vs legacy leverage/entryMarginPercent (client) — engine direction-specific.
2. Engine signal status literal 'باز شده' vs client open-time string (engine:1095).
3. profitRate×100 (open pos) vs realizedPnlRate direct (closed pos) — different scales from two Toobit endpoints.
4. Hardcoded API keys fallback in create/close-position (route.ts:12-14) + settings.html — never replicate.
5. RSI off-by-one (array N−1, shifted) in BOTH JS and TS port (engine:229-258 copies quirk verbatim).
6. contractSize 0.11 hardcoded for every symbol; qty Math.ceil (over-rounds fractional closes).
7. userTrades query manually unsorted (signature must cover exact order symbol,limit,recvWindow,timestamp).
8. Dashboard analyzer: SPOT-style symbol (symbolName+'USDT') for klines + dailyCloses lookahead + single rsiThreshold 50 — legacy.

---
Task ID: m3-doc-research
Agent: docs-researcher
Task: Toobit official API docs — TP/SL read-back endpoint + pagination + kline intervals

## Official docs location (found)
- Root: https://api-docs.toobit.com/ (VitePress, en/zh; linked from www.toobit.com/docs). Old leads dead:
  toobit-docs.github.io=404, github.com/toobit=unrelated personal user, toobitdev/toobit-api=empty repo.
- v1 USDT-M account/trade: https://api-docs.toobit.com/api/usdt-m-account-and-trading
- v2 orders/algo: https://api-docs.toobit.com/api/usdt-m-api-v2
- market data: https://api-docs.toobit.com/api/usdt-m-market-data | enums: https://api-docs.toobit.com/api/basic-information

## TP/SL read-back (core answer)
- NO documented GET on /api/v1/futures/position/trading-stop — v1 docs list POST only (weight 3; params: symbol!, side! LONG|SHORT,
  takeProfit?, stopLoss?, tpTriggerBy?, slTriggerBy? MARK_PRICE|CONTRACT_PRICE, tpSize?, slSize?, stopType? FIXED_STOP|TRAILING_STOP,
  activePrice?, fallbackType? RATE|PRICE, fallbackQuantity?, category?, timestamp!, recvWindow?; response echoes the config).
- Position TP/SL materializes as conditional rows type=STOP_PROFIT_LOSS. Documented read-back paths:
  1) GET /api/v1/futures/openOrders with type=STOP_PROFIT_LOSS (+symbol). Weight 1. Params: symbol?, orderId? (cursor, "<orderId"),
     type? (LIMIT default | STOP | STOP_PROFIT_LOSS), category?, limit? (def20, 1..1000), timestamp!, recvWindow?.
     STOP_PROFIT_LOSS row fields: stopPrice (trigger), triggerBy, triggerType (0 fixed|1 dyn), activePrice, fallType (0|1=RATE|2=PRICE),
     fallQuantity, activeStatus, orderType (STOP_LONG_PROFIT|STOP_LONG_LOSS|STOP_SHORT_PROFIT|STOP_SHORT_LOSS), side (SELL_CLOSE for
     long-TP), status (ORDER_NEW), clientOrderId auto-generated "STOP_LONG_PROFIT_<ts>", executedOrderId, priceType.
     Default type=LIMIT → earlier live "200 []" is CONSISTENT (TP/SL rows excluded unless type=STOP/STOP_PROFIT_LOSS passed). Re-test needed.
  2) GET /api/v1/futures/order (single): orderId|origClientOrderId (one required), type only LIMIT|STOP; note: "when type=STOP result may
     be a STOP or STOP_PROFIT_LOSS order" — same STOP_PROFIT_LOSS schema. Weight 1.
  3) v2 (cleanest): GET /api/v2/futures/open-algo-orders with stopCategory=STOP_PROFIT_LOSS (+symbol). Weight 1. Params: symbol?,
     orderId? (cursor), stopCategory? (STOP=plan only | STOP_PROFIT_LOSS=TP/SL only; if OMITTED → plan STOP only, TP/SL EXCLUDED!),
     limit? (def20, 1..1000), category?, timestamp!, recvWindow?. Row: type STOP_PROFIT_LOSS|STOP_PROFIT_LOSS_MARKET, stopPrice,
     triggerBy, stopOrderType TAKE_PROFIT|STOP_LOSS, stopType FIXED_STOP|TRAILING_STOP, trailing: activePrice/fallbackType/fallbackQuantity/
     activeStatus, side BUY|SELL, positionSide LONG|SHORT.
  - v2 history: GET /api/v2/futures/history-algo-orders (+startTime/endTime) for triggered/canceled TP/SL rows. Single: GET /api/v2/futures/algo-order.
- Modify TP/SL row: POST /api/v1/futures/order/update (type=STOP_PROFIT_LOSS, row must be ORDER_NEW) or POST /api/v2/futures/algo-order/update.
  Cancel: DELETE /api/v1/futures/order (type=STOP may resolve to STOP_PROFIT_LOSS row) or DELETE /api/v2/futures/algo-order.
- GET /api/v1/futures/positions: docs schema has NO TP/SL fields (matches live). v2 has no positions endpoints at all.

## Orders / pagination params (v1)
- openOrders: see above. Note: "if orderId is sent, all orders < orderId returned".
- historyOrders (w5): symbol?, orderId?, type? (LIMIT default | STOP), startTime? (def 3 days ago), endTime?, limit? (def20, 1..1000),
  category?, timestamp!, recvWindow?. NO documented `state` param on v1.
- userTrades (w5): symbol!, startTime?, endTime?, limit? (def20, 1..1000), fromId?, toId?, category?, recvWindow?, timestamp!.
- historyPositions (w5): symbol?, marginType? ISOLATED|CROSS, fromId? (cursor, def0), toId?, startTime? (def0), endTime?,
  limit? (def20, 1..1000), category?, timestamp!, recvWindow?. Cursor = response row `id`. NO pageSize documented (live ignores it).
  Docs claim limit max 1000 but live caps at 200 (empirical) — use <=200.
- v2 open-orders/history-orders/user-trades: same shape; limit def20 1..1000, orderId cursor, time = rolling window defaults.

## Klines GET /quote/v1/klines (public, w1)
- Params: symbol!, interval! (ENUM), startTime?, endTime?, limit? (def1000, max1000; no times -> only latest kline).
- interval enum (basic-information#kline-candlestick-chart-intervals): 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 1w 1M.
  VERIFIED live today: all 14 work; 45m/2d/3M -> {"code":-10009,"msg":"Invalid period!"}. WS kline topic: subset (no 3m/8h).

## Next actions
1. Signed re-test on live acct: GET /api/v1/futures/openOrders?type=STOP_PROFIT_LOSS&symbol=<SYM>-SWAP-USDT with TP/SL attached; expect
   STOP_PROFIT_LOSS rows (orderType STOP_LONG_PROFIT / STOP_LONG_LOSS etc.).
2. Also test GET /api/v2/futures/open-algo-orders?stopCategory=STOP_PROFIT_LOSS — stopCategory is MANDATORY to see TP/SL rows.
3. Wire TP/SL read-back into toobit client read path; treat stopPrice/triggerBy/orderType as canonical; map v1 orderType <-> v2 stopOrderType.

---
Task ID: m3-server-core
Agent: orchestrator (main session)
Task: Mission-3 server core — §2 TP/SL read-back, §6 fidelity fixes, §8 stats endpoint + comparative tests (commit 1e425a2)

Work Log:
- Live probes (read-only GET) verified: positions payload has NO TP/SL; TP/SL read-back = GET /api/v1/futures/openOrders?type=STOP_PROFIT_LOSS (rows: orderType STOP_{LONG|SHORT}_{PROFIT|LOSS}, stopPrice, status ORDER_NEW); historyPositions honors `limit` (live cap 200, pageSize ignored); profitRate & realizedPnlRate BOTH fractions (ref displays realizedPnlRate raw = ×100 bug — V2 correct, documented)
- endpoints.ts: + stopOrders (type=STOP_PROFIT_LOSS), historyPositions limit param
- client.ts: + getStopOrders, getOpenPositionsFull (tri-state tpslStatus ok/unknown), buildTpslMap (exported, tested); positions/open route serves full positions
- core/signals/status.ts: window start = candleOpenTime (ref semantics), symbol normalization (short vs full), expiry from candleOpenTime
- settings.isSignalExpired: age from candleOpenTime (ref automation-manager.js:1189)
- controls.ts: SAME_DIRECTION_CANDLES = PREFIX semantics (first N post-signal candles incl. forming, doji rejects); PRICE_DISTANCE reads ctx.lastOpenPrice (trade-history OPEN fill, ref getLastEntryPrice), null → control skipped
- cycle-engine: NEW step fetches userTrades + resolveSignalStatus — latest signal trades ONLY if PENDING (SIGNAL_ALREADY_OPENED gate prevents re-trading an opened signal); opposite-close failure NON-FATAL (ref); positions re-fetched post-close for controls; cycle price = last kline close (ref fetchPrice), order-qty price = ticker (unchanged); postSignalCandles include forming candle
- market/analysis route: statuses resolved against real fills when credentials exist (fallback age-only)
- NEW server/analytics/symbol-stats.ts + /api/diagnostics/symbol-stats (limit 200, truncated flag; dedup by id; winRate; after-fee netIncome; count DESC, netIncome DESC, symbol ASC)
- Tests: tests/tpsl-mapping.test.ts (11✓), tests/symbol-stats.test.ts (24✓), tests/fidelity.test.ts (34✓ — independent reference twins: RSI shift identity, ATR exact, TP/SL incl. shortFixedSl=6, Long/Short/none 50-candle fixtures, OPENED gate, prefix candles, PnL scales, qty contract); package.json `test` runs all 4 suites; tsc+eslint clean
- ESLint gotcha documented: bare `{}` block right after un-terminated arrow statement (`})`) breaks the TS parser (ASI) — terminating semicolon added

Stage Summary:
- Server core for mission §1-§8 done; frontend remains (§1 dialog, §3 unified table, §4 fmtDateTime, §5 font, §7 chart-nav, §8-UI stats, §9 layout, §10 tables audit)
- TP/SL live values on test account: XRP-SHORT TP 1.1987 / SL 1.465; DOT-SHORT TP 1.0286 / SL 1.2572 (fixtures sanitized)

---
Task ID: m3-fe-1
Agent: fe-1-formatter
Task: Mission §4 central Jalali datetime + §5 self-hosted Vazirmatn
Commit: 02bb8cc (feature) + worklog commit

Work Log:
- format.ts REWRITTEN (date half): single source of truth = `Intl.DateTimeFormat('fa-IR-u-nu-arabext', { calendar:'persian', timeZone:'Asia/Tehran', year/month/day/hour/min/sec 2-digit, hour12:false })` × formatToParts → `YYYY/MM/DD, HH:mm:ss` (e.g. ۱۴۰۵/۰۷/۲۹, ۱۰:۰۵:۵۰). fmtDateTime accepts string|number|Date|null|undefined (ISO server LogRecord.created_at, epoch-ms step `at`, Date); strict toValidDate gate — null/undefined/''/NaN/'garbage' → '—', never "Invalid Date", never fabricated. fmtTime = same locale/tz, time-only (seconds kept, now Tehran+Persian digits). fmtAgo kept exported (signature widened to Date input too) but has ZERO call sites now.
- fmtAgo audit (every call site): ONLY ONE existed — AutomationView.tsx:703 symbols-table «آخرین چرخه» column (relative age for last cycle). Mission §9.2 wants full Jalali time with seconds there → REPLACED with fmtDateTime(s.lastCycleTime); null → '—' via the gate. fmtAgo not deleted — a later task may want relative chips («X دقیقه پیش» is inappropriate for tabular timestamps; kept only for potential explicit relative-age contexts).
- Call sites now flowing through the central fn (verified by grep — zero `new Date(`/`toLocale*` date usages remain under src/modules/**):
  - AutomationView.tsx:429 log table «زمان» fmtDateTime(l.created_at) — unchanged call, new format (was MM/DD، HH:mm, browser-local, no year) — .num isolation kept as-is.
  - AutomationView.tsx:705 symbols table «آخرین چرخه» fmtAgo→fmtDateTime (see above). Column width 110px→165px — MINIMAL accommodation so the 19-char datetime fits; symbols table already h-scrolls (audit: 430px min in 360-380px column) — real layout fix belongs to the later §9 task.
  - AutomationView.tsx:727 signals table time fmtDateTime(signalConfirmedAt) — .num kept.
  - AutomationView.tsx:808 cycle-summary badge fmtDateTime(last.finishedAt) — mixed RTL text, renders naturally (Extended Arabic-Indic digits are bidi class EN → whole token one number run; no new bdi added per §4).
  - AutomationView.tsx:872 step rows fmtTime(s.at) — now Tehran + Persian digits + seconds.
  - AutomationView.tsx:992 pending chip «تأیید» fmtDateTime inside existing bdi.num — isolation kept (RTL "تأیید" + LTR-isolated datetime both fine).
  - drawingRender.ts:59-63 fmtBarTime(timeSec) → delegates to fmtDateTime(timeSec*1000); vertical-line tag (used at :390) now full Jalali with seconds; Persian digits are plain unicode chars — canvas LTR text renders them correctly.
- NOT touched (intentional): all `toLocaleString('en-US')` money/number formatting (format.ts fmtNum/fmtUsd, controls.ts:63, cycle-engine.ts:47); unused shadcn stock components ui/calendar.tsx + ui/chart.tsx (not imported anywhere — their date.toLocale* is inert); ALL server code stays UTC ISO (bale.ts, cycle-engine.ts toISOString, api routes) per §4.2.
- §5 Fonts: jsdelivr v33.005 tag DOES NOT EXIST (404 "Failed to fetch") → fell back to v33.003 per mission. Downloaded to public/fonts/ (all `wOF2` magic verified): Vazirmatn-Regular.woff2 50,684B (400), Medium 51,128B (500), SemiBold 51,032B (600), Bold 51,020B (700), ExtraBold 51,120B (800) — 254,984B total. DEVIATION from task's "4 weights": grep audit found font-weight:800 used at globals.css:183,366,575,734,979,1256,1277,1286 (.kpi-value, .modal-title, section titles) + ChartToolbar.tsx:215 (ticker price) → 800 included per the "include every weight referenced" rule; no weight invented without a file (all 5 exist in the repo's fonts/webfonts/).
- globals.css: 5 @font-face blocks (font-display:swap, no unicode-range) inserted before :root; body font-family chain `'Vazirmatn', system-ui, -apple-system, sans-serif` (globals.css:118+22 shift) UNCHANGED; .num tabular-nums + .mono untouched. layout.tsx: jsdelivr <link> REMOVED (comment documents self-hosting); theme pre-paint script untouched. chartTheme.ts:64 + drawingRender.ts:225 reference family name only — unchanged, still valid.
- Tests: NEW tests/datetime-format.test.ts (bun, plain script, process.exit) — 23 checks PASS: loud ICU gate (aborts if arabext digits unsupported); hard-coded 2026-10-20T06:30:50Z → «۱۴۰۵/۰۷/۲۸, ۱۰:۰۰:۵۰» (verified by Intl probe + manual arithmetic: 1 Farvardin 1405 = 2026-03-21, Oct 20 = day 214 → 28 Mehr; Tehran UTC+3:30 no-DST); midnight rollover 2026-10-20T21:00:00Z → «۱۴۰۵/۰۷/۲۹, ۰۰:۳۰:۰۰» + explicit h24-bug guard (never ۲۴); null/undefined/''/'garbage'/NaN/'not-a-date' → '—'; ISO string vs epoch-ms vs Date → byte-identical output; Persian-digit regex ^[\u06F0-\u06F9]{4}/...$ structure; seconds always present; fmtTime timezone case; fmtAgo sanity (legacy Latin digit kept — out of §4 scope). package.json `test` now chains 5 suites: pnl 15✓, tpsl 11✓, symbol-stats 24✓, fidelity 34✓, datetime 23✓ — ALL PASS.
- Quality gates: `npx tsc --noEmit` → 0 errors; `bun run lint` → 0 errors; dev.log after changes → only 200s (2×401 were my wrong-password login probes), compiles clean, no new errors.
- agent-browser E2E (read-only, did NOT click «اجرای یک چرخه»): login admin/test1234 → 401 (creds already seeded from earlier sessions — worklog line 1420 says current creds are admin/admin123) → admin/admin123 → 200, automation view renders. Rendered cells verified via snapshot: cycle badge «۱۴۰۵/۰۷/۲۹, ۱۰:۲۷:۲۵», log rows «۱۴۰۵/۰۷/۲۹, ۱۰:۲۷:۲۴», signals table «۱۴۰۵/۰۷/۱۳, ۰۱:۳۰:۰۰», pending chip «۱۴۰۵/۰۷/۱۳, ۰۱:۳۰:۰۰», steps «۱۰:۲۷:۲۴» — all target format. Fonts: `document.fonts.check('16px Vazirmatn')` → true; FontFace list shows Vazirmatn 400/500/600/700/800 all `loaded`; network: GET /fonts/*.woff2 ×5 → 200, `--filter jsdelivr` → «No requests captured»; glyph-metric proof: canvas measureText('تریدبات پنل معاملاتی') = 132.5px in Vazirmatn vs 137.88px in sans-serif → Vazirmatn genuinely rendering. body computed font-family unchanged. Screenshots: /tmp/m3fe1-login.png, /tmp/m3fe1-automation.png.
- Note for later §9 layout task: symbols-table «آخرین چرخه» cells currently render '—' (lastCycleTime null in stored state); fmtDateTime path is live-verified via the other 6 columns + suite, but a live full-datetime cell there will only appear once a cycle updates lastCycleTime in persisted state.

Stage Summary:
- §4 done: ONE central Jalali datetime (Tehran, Persian digits, seconds) everywhere; server stays UTC ISO; fmtAgo demoted to zero call sites.
- §5 done: Vazirmatn fully self-hosted (5 weights), zero external requests, family/chains/isolation untouched.
---
Task ID: m3-fe-2a
Agent: fe-integrator (main session)
Task: Complete the canceled run — §1.1 close-dialog integration + §1.2 PnL inversion + §2-UI TP/SL columns + mock-based tests/E2E

Work Log:
- KEPT the previous agent's partial work unmodified: CloseConfirmDialog.tsx (complete, shadcn dialog, props position/submitting/onConfirm/onOpenChange) + format.ts fmtUsdtAmount()/tpslLabel() (tri-state). Server code untouched.
- AutomationView.tsx integration (§1.1): removed `closing` state + the row button's direct-POST path; added `closeTarget: OpenPosition | null` + `closeSubmitting`. Row «بستن» = `setCloseTarget(p)` ONLY. `<CloseConfirmDialog>` (view end) is the ONLY trigger of POST /api/positions/close via `onConfirm → closePosition(closeTarget)`. `onOpenChange(false)` vetoed while submitting (dialog also vetoes Escape/backdrop via preventDefault); otherwise clears closeTarget. closePosition: double-submit guard, success → toast «{closed} پوزیشن بسته شد», failure → warning toast with REAL reason (`[r.error, ...r.errors].filter(Boolean).join(' — ')`), throw → danger toast, `refreshPositions()` on result, closeSubmitting/closeTarget cleared in finally.
- PnL column (§1.2) INVERTED: `fmtPct(p.profitRate)` primary/larger colored by pnlColor(unrealizedPnL) in mono; `(<bdi className="num">{fmtUsdtAmount(p.unrealizedPnL)} USDT</bdi>)` in <small opacity .8> same hue; both null → `— (—)` all muted; one null → available + `—`. LTR isolation matches neighbors (mono + bdi.num; column ltr:true).
- TP/SL column (§2-UI): two stacked lines `TP: …` / `SL: …` via tpslLabel(value, tpslStatus) + module-level TpslLine helper — price → TP green/SL red (.long/.short = var(--success)/var(--danger), same hues as signals table), unset → var(--text-muted), unknown → var(--warning) opacity .85 + `title="دریافت TP/SL از صرافی ناموفق بود"`. Replaces the always-«— / —» cell.
- tests/close-confirm.test.ts NEW (bun plain script, 22✓): fmtUsdtAmount (+12.30, −4.80 with U+2212 check, 0.00, +0.00 rounding, null/undefined/NaN → —, thousands separators) + tpslLabel (ok+value→price, ok+null→«تنظیم نشده»/unset, unknown→«نامشخص» EVEN with stray value, unknown+null, undefined status+value→price, undefined status+null→unknown, XRP fixture 1.1987→'1.2'). package.json `test` chains 6 suites.
- E2E (agent-browser, admin/admin123, request-ledger `network requests --filter positions/close`):
  - Dialog open → 0 requests; Escape → 0; «انصراف» → 0; backdrop click → 0.
  - Confirm click → EXACTLY +1 POST (ledger 3→4), in-flight buttons `[{انصراف disabled:true},{«در حال بستن…» disabled:true ariaBusy:"true"}]` (1.5s fetch delay wrapper), after resolve: dialog closed + toast «بستن پوزیشن | 1 پوزیشن بسته شد» + GET /api/positions/open re-fetch follows (then balance+status = refreshPositions cascade).
  - INCIDENT (deviation from "NO real orders"): the given mock pattern `/api/positions/close` does NOT match (Playwright globs match the FULL URL) — the FIRST E2E confirm really closed XRP-SHORT on the test account (dev.log POST 200 in 781ms; XRP gone from open positions; $2.16 margin, −$0.11 PnL). Lesson recorded: agent-browser route patterns need `**/` prefix for relative paths. Fix: `**/api/positions/close`, interception PROVEN before any further confirm click (synthetic ZZZMOCK2 fetch → mock body returned, dev.log close-POST count unchanged; pre-fix ZZZMOCK probe hit the server but matched no position → {closed:0}, zero orders by client filter). All later E2E steps mock-safe; `network unroute` at end.
  - Live cell evidence (a11y snapshot before incident): XRP `TP: 1.2 SL: 1.47` (real 1.1987/1.465), DOT `TP: 1.03 SL: 1.26`, DYDX `TP: 0.13 SL: 0.11`; PnL cells `+3٪ (+0.06 USDT)` / `−4.9٪ (−0.11 USDT)` — real TP/SL now DISPLAY instead of «— / —».
  - Screenshots VLM-verified (1440 + 390 incl. RTL h-scroll via negative scrollLeft): /tmp/m3fe2a-positions-1440.png, -dialog-1440.png, -positions-390.png, -positions-390-scrolled.png — percent primary + (USDT) secondary, TP green/SL red stacked, no garble/overlap.
- Gates: `npx tsc --noEmit` 0; `bun run lint` 0; `bun run test` ALL GREEN (pnl 15✓, tpsl 11✓, symbol-stats 24✓, fidelity 34✓, datetime 23✓, close-confirm 22✓); dev.log clean (200s only).

Stage Summary:
- §1.1 dialog gate live: zero network on open/Escape/backdrop/انصراف, exactly one POST per confirm, submitting locks all dismissals; §1.2 PnL inverted; §2-UI TP/SL tri-state live against real exchange stop-orders.
- KNOWN STATE CHANGE: test account now has 2 open positions (XRP-SHORT closed by the E2E incident above) — document for any task relying on "3 live positions".

---
Task ID: m3-fe-2b
Agent: fe-integrator (main session — completing a timed-out run)
Task: Finish §3 unified cycle/log panel + §8-UI symbol-stats table + §9 desktop 1/3|2/3 top layout + §10 tables audit (the timed-out agent left the work UNCOMMITTED)

Work Log:
- AUDIT of the hand-off (all per agent-ctx/m3-fe-2b-fe-integrator.md plan): the timed-out run had ALREADY implemented essentially everything — §3 one unified «چرخه و رویدادها» panel (compact .cycle-summary chips: action badge/نماد/شروع/پایان fmtDateTime/مدت اجرا fmtDurationFa/مراحل ok·warn·fail counts/بودجه ذخیره‌سازی/منبع + اجرای یک چرخه + جزئیات اجرا funnel→logCycle + shortened-id copy) above ONE DataTable (زمان|نماد|فرایند/مرحله|وضعیت|جزئیات|شناسه چرخه; 8-char id + «…» click-to-copy w/ title=full; expanded: message/full id+copy/منبع/مرحله/مدت اجرا/KV grid, «چرخه جاری» badge + .tb-row-current accent; NO per-row funnel; single-cycle filter sorts by step ordinal; 5 distinct LOG_STATUS_META labels); §8-UI SymbolStatsTable (DataTable-based sidebar+inpage variants, loading/«خطای دریافت آمار»/«داده‌ای موجود نیست» states, coverage note «بر اساس N معامله اخیر» + «(ممکن است کامل نباشد)»); §9 .top-grid minmax(300px,1fr)+minmax(0,2fr), --sidebar-width 272→320px, .sidebar-stats block, .stats-inpage ≤1024px twin, symbols compact cols (نماد/وضعیت/خطا/آخرین چرخه two-line fmtDateTime/حذف); §10 DataTable compact/fixed/rowClassName props + expanded colSpan columns.length+1 + dead-CSS tombstones (.content-grid→.top-grid, .side-panel/.log-timeline/.step-* removed) + tooltip ::after zero-size until hover (phantom scrollWidth fix). Old split (cycle-status + step list + separate logs panel) fully deleted, no refs remain.
- GAPS found by audit + fixes:
  1. AutomationView.tsx:87 — ACTION_LABELS.SIGNAL_ALREADY_OPENED was badge-info; plan/spec says warning (trade-preventing gate, same family as SIGNAL_EXPIRED/STALE) → badge-warning. (The new server action value now has its Persian label «سیگنال قبلاً باز شده» — verified present in the map.)
  2. DataTable.tsx:98-105 — phantom 7th column: expandable tables append an auto `<col/>` for the sr-only «جزئیات» header; with table-layout:fixed Chrome split the leftover width so the message column lost ~16px (measured 207px) to an invisible trailing column → `<col style={{width:0}}/>`; re-measured 223px/0px.
  3. globals.css:1433-1442 — page-level RTL horizontal overflow at phone widths: the ≤1280 stacked track was bare `1fr`, so the unified table's minWidth 560px became the track's min-content (598px incl. panel padding) → document.scrollWidth 610 > 390 viewport. Pre-existing (old table was 760px → ~810px overflow before this task) but now FIXED: `grid-template-columns: minmax(0, 1fr)`; verified docScrollW 390 == winW 390, unified .table-scroll scrolls INTERNALLY (328px box) as mission §1 intends.
- Turbopack dev gotcha (documented for later agents): after editing globals.css the served CSS chunk stayed stale — `curl` of the chunk showed the old rule — until a page request re-triggered compilation; a touch + browser reload then picked it up. Trust curl-of-chunk, not browser state, when probing CSS.
- E2E (agent-browser; admin/admin123 session; NO trading actions — zero POSTs in the request ledger; NO run-cycle clicks; never touched بستن):
  - 1440px: .top-grid two panels measured 348.66px | 697.34px (ratio 1:2.00); symbols .table-scroll scrollWidth 311 == clientWidth 311 (NO h-scroll); unified 659 == 659 (NO h-scroll); header widths 126/58/100/74/223/78 (+0 hidden col); summary Jalali «۱۴۰۵/۰۷/۲۹, ۱۰:۲۷:۲۴»+«۲۶۵ms» (SIGNAL_EXPIRED badge, DOT); status filter=SKIPPED → exactly 1 row «رد/ردشده» + «حذف فیلترها» appears; row expand → پیام/شناسه چرخه c_mvhrf64f_y2cxwu + «چرخه جاری» badge + copy btn + منبع دستی/مرحله ۱/مدت اجرا ۰ms/KV settingsVersion=v1,hasCredentials=true, funnel icons in row: 0; short-id button title=«کپی شناسه کامل: c_mvhrf64f_y2cxwu», click → toast + row NOT toggled (stopPropagation works); SIDEBAR stats 7 real rows (DOT 82/39٪/+2.03 · XRP 56/39٪/−1.16 · DYDX 33/33٪/−1.18 · TON · APT · ARB · SPCX) + note «بر اساس ۲۰۰ معامله اخیر (ممکن است کامل نباشد)»; .stats-inpage display:none at desktop.
  - 768px: track 732px (stacked), in-page stats panel visible (7 rows), sidebar off-canvas (translateX(320px)).
  - 390px: docScrollW 390 == winW (overflow fixed); drawer opens (x:70, w:320, backdrop active, body scroll lock), stats usable inside (scrollWidth 287 == clientWidth 287); REAL `press Escape` closes it (synthetic document.dispatchEvent does NOT reach the window keydown listener — headless quirk); footer: .main-content min-height 844px + .app-footer margin-top:auto, docH 3347 → footer pushed naturally, no overlay.
  - Headless clipboard: copy click → graceful «کپی ناموفق» info toast WITH the id (clipboard denied headless; execCommand fallback is wired — real browsers OK).
  - Screenshots /tmp/m3fe2b-1440.png, /tmp/m3fe2b-768.png, /tmp/m3fe2b-390.png, /tmp/m3fe2b-390-drawer.png — VLM-verified: two top panels side by side (1440), stacked + stats panel in main column (768), drawer stats with backdrop (390), no overlap/garbled text.
- §10 audit results per table: positions (full-width, minWidth 680, PnL percent-primary + TP/SL tri-state lines, chart-nav + بستن aria-labels ✓); signals (full-width, minWidth 600, chart aria-label ✓); symbols (1fr panel, compact+fixed, minWidth 240, NO h-scroll ≥1281, remove aria-label ✓); symbol-stats sidebar/inpage (compact, minWidth 240/340, fits 292px sidebar content ✓); unified (2fr panel, compact+fixed, minWidth 560 — deliberately BELOW the plan's ~640 so all 6 columns fit the 2fr track at 1281px (587px) with zero h-scroll; message col flexes +16px after the phantom-col fix); sticky thead + tb-empty-row verified in DataTable core; tooltip phantom-overflow fix global.
- Gates: `npx tsc --noEmit` 0 · `bun run lint` 0 · `bun run test` ALL 6 GREEN (pnl 15✓, tpsl 11✓, symbol-stats 24✓, fidelity 34✓, datetime 23✓, close-confirm 22✓) · dev.log tail clean (200s only, no hydration issues) · zero browser console errors.

Stage Summary:
- §3/§8-UI/§9/§10 complete and committed: ONE unified cycle+log panel (summary + single table, old split gone), symbol-stats table in sidebar (desktop) / in-page panel (≤1024) / drawer copy (mobile) with coverage + error/empty states, 1/3|2/3 desktop top grid that stacks ≤1280 with no page-level overflow at any width, tables audited & compact-fitted.
- Follow-up notes: test account still has 2 open positions (from the m3-fe-2a incident); symbols «آخرین چرخه» cells show «—» until the persisted symbols state records a lastCycleTime (server-side field untouched per this task's scope).

---
Task ID: m3-fe-2c
Agent: fe-2c-chartnav (agent timed out; orchestrator completed verification)
Task: Mission §7 — signal → professional chart navigation

Work Log:
- Contract: page-level chartFocus state {symbol, interval, signalTime(ms), side, price, tp, sl} + URL params ?chart=&interval=&focus=<ms>&side= (history.replaceState; parsed on mount → refresh-restorable; manual symbol/interval change drops focus)
- klines route + client.getKlines: optional startTime/endTime (ms) passthrough (Toobit-documented params) — the ONLY server change; read-only
- Signals table rows fully clickable (cursor-pointer + stopPropagation on inner buttons); action column = icon-only chart button w/ title+aria «نمایش در چارت حرفه‌ای»
- ChartView: focus bar located via binary search (ms-documented); older-than-window signals load history (startTime = focus − 250×interval, limit 500) then center on the bar (idx−80…idx+40); synthetic marker from focus payload if absent from analysis markers; Entry/TP/SL price lines for focused signal; «بازگشت به اکنون» button clears focus + returns to latest bars; unfound bar → clear message, no wrong jump
- New tests/chart-focus-url.test.ts (21✓ — URL build/parse round-trip, ms units, invalid params, refresh restore) — chained in package.json test
- Orchestrator E2E verification: clicked signal row (Short 1405/07/13) → chart opened, URL ?chart=BTC&interval=1h&focus=1791147600000&side=Short; visibleRange 1790859600..1791291600 CONTAINS focus bar 1791147600 (signal was ~240 bars old → history fetch path exercised); markersCount=1 exactly at 1791147600; focusInfo {side:Short, price:85828.6}; «بازگشت به اکنون — جدیدترین کندلها» button present; screenshot saved

Stage Summary:
- All mission sections implemented: §1-§10 done; §7 verified E2E. tsc 0, lint 0, 7 test suites 150 checks green

---
Task ID: m3-final
Agent: orchestrator (main session)
Task: Mission-3 delivery report + final gates + GitHub push

Work Log:
- Final gates re-verified: tsc 0, eslint 0, bun run test = 7 suites / 150 checks green, dev.log clean
- E2E re-verified by orchestrator: signal row click → chart focused (visibleRange contains signal bar 1791147600, marker count=1 at bar, URL restorable, بازگشت به اکنون present)
- DELIVERY-REPORT-MISSION3.md written (14 required items + incident disclosure + security notes)
- Pushed main to github.com/drvesali1374-ai/TradeBot-Production-V2 (token provided by owner in chat; replaces remote history per owner instruction)

Stage Summary:
- Mission §1–§11 complete and evidence-backed. Remaining owner actions: revoke API keys + PAT; decide cron-secret naming; CI optional.
---
Task ID: m4-server
Agent: server-core
Task: New Jalali cycle-ID format (item 5) + symbols default-fallback fix (item 9) + auth/API-key isolation regression tests (item 11)

Work Log:
- Item 5 — NEW src/server/automation/cycle-id.ts: `makeCycleId(symbol, at = Date.now())` → `{SYMBOL}_{YYYYMMDD}_{HHMMSS}` via `Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone:'Asia/Tehran', 2-digit fields, hour12:false }).formatToParts` — parts extracted by TYPE (no string slicing), symbol sanitized to [A-Z0-9] uppercase (null/undefined/empty/dirty → `CYCLE`), h24→00 guard, ASCII digits. Verified by probe: 2026-10-22T07:01:26Z = 1405/07/30 10:31:26 Tehran → `DOT_14050730_103126` (the owner's example).
- cycle-context.ts: `readonly cycleId` → `private _cycleId` + `get cycleId()` + `rekey(cycleId)` (documented: re-keys once the symbol is known; the engine keeps the internal id for the lock).
- cycle-engine.ts: old generator renamed `makeLockId()` (internal `c_...` id — used for tryAcquireLock/releaseLock ONLY, stable for the whole run); `finish()` now returns `ctx.cycleId` (the possibly re-keyed PUBLIC id), not a captured const; rekey sites: (a) right after symbol selection (`ctx.rekey(makeCycleId(symbol, startedAt))` — keyed to cycle start instant), (b) parallel-lock ERROR early exit → `makeCycleId(null, …)` → `CYCLE_…`, (c) NO_READY_SYMBOL early exit (before markCycleStart) → `CYCLE_…`, (d) catch block when `ctx.symbolIndex < 0` → `makeCycleId(options.symbolOverride ?? null, …)`. `heldBy: lock.heldBy?.cycleId` unchanged (other cycle's internal id is fine). persistCycleOutcome logs the new public id via result.cycleId.
- Engine-wiring PROOF (SAFEST path — NO run-cycle POST against the live server was made; chosen per spec because real API credentials may exist in KV and a signal could fire a REAL order): throwaway bun script ran real `runCycle()` against a TEMP TB_DATA_FILE with NO credentials (signed calls impossible → zero order risk): CASE1 all-symbols-waiting → NO_READY_SYMBOL + `CYCLE_14050801_230012`; CASE2 foreign active lock → ERROR «چرخه موازی» + `CYCLE_14050801_230012`, foreign lock record untouched; CASE3 symbolOverride ZZZFAKE → selected+rekeyed → `ZZZFAKE_14050801_230012`, steps …انتخاب نماد→داده بازار→خطای چرخه, lock released (public klines only, credential warning step present). Script deleted afterwards; temp files cleaned.
- Item 9 — NEW src/core/symbols.ts: `DEFAULT_SYMBOLS` (DOT id1/BTC id2/ETH id3, waiting, errorCount 0, lastCycleTime null) + `cloneDefaultSymbols()` (entries are mutated in place by engine/POST → constant must never be shared mutably). Re-exported from src/core/index.ts (named-export style matches existing lines).
- Routes: symbols/route.ts local DEFAULTS deleted → `?? cloneDefaultSymbols()` (clone because POST mutates); status/route.ts `symbols ?? []` → `symbols ?? DEFAULT_SYMBOLS` (read-only serialization) — fixes the fresh-deployment bug (UI showed EMPTY table while engine traded DOT/BTC/ETH; re-adding DOT → «این نماد قبلاً اضافه شده است»); cycle-engine inline fallback literal → `cloneDefaultSymbols()`.
- Live read-only verification: login admin/admin123 → GET /api/automation/status now returns symbols [DOT,BTC,ETH] (was `[]`; live db/trading_data.json still has ONLY auth_credentials — no state changed). NO run-cycle POST, no browser actions, no position changes.
- Item 11 — tests/auth-isolation.test.ts (20✓): fresh TB_DATA_FILE (`/tmp/tb-auth-test-${pid}.json`, set before any storage import via dynamic imports); Test1 fresh login writes ONLY `automationState:auth_credentials` (username myuser, hashed password) and NO `automationState:settings_apiKeys` (list() + get() absence); Test2 saveAccountSettings(REAL_KEY/REAL_SECRET) → re-login same creds → account keys UNCHANGED + credentials UNCHANGED; Test3 wrong password → ok:false + both stores byte-identical; final `list()` = exactly the two isolated keys. Proves login/settings can never cross-write (owner's reported bug not reproducible — isolation regression-locked).
- NEW tests/cycle-id.test.ts (31✓): format regex `^([A-Z0-9]+)_\d{8}_\d{6}$` + no Persian digits; hard-coded Jalali expectations (DOT_14050730_103126 owner example, Nowruz BTC_14050101_000100, Tehran-midnight h24 guard ETH_14050801_000000, UTC+3:30 shift DOT_14050729_140126); Intl cross-check with an INDEPENDENT numeric-fields formatter for 6 timestamps; sanitization (dot/DoT/'do t!'/'D-O-T' collapse; null/undefined/''/### → CYCLE_); same-input determinism + shared datetime suffix across symbols.
- NEW tests/symbols-defaults.test.ts (29✓): DEFAULT_SYMBOLS shape/ids/status; cloneDefaultSymbols independence (mutation never leaks); core re-export IDENTITY (===); route-level regression WITHOUT a server — bun imports the route modules directly against a temp TB_DATA_FILE: status GET returns DEFAULT_SYMBOLS for fresh storage (the exact bug scenario), symbols GET returns the same, POST add DOT → 400 «این نماد قبلاً اضافه شده است» without polluting the shared constant. package.json `test` chain now runs 10 suites sequentially.
- Gates: `npx tsc --noEmit` → 0 errors; `bun run lint` → 0 errors; `bun run test` → ALL 10 suites GREEN (pnl 15✓, tpsl 11✓, symbol-stats 24✓, fidelity 34✓, datetime 23✓, close-confirm 22✓, chart-focus-url 21✓, cycle-id 31✓, symbols-defaults 29✓, auth-isolation 20✓ = 230 checks); dev.log clean (only 200s; status route 401 unauthenticated → 200 with cookie after hot reload).
- Deviation: commit uses explicit file list instead of `git add -A` — a parallel agent has uncommitted changes in src/modules/chart/ChartView.tsx which must NOT be swept into this commit.

Stage Summary:
- Item 5 done: public cycle ids are `{SYMBOL}_{JALALI YYYYMMDD}_{HHMMSS}` (Tehran, ASCII) with `CYCLE_` prefix for pre-selection exits; the concurrency lock keeps a stable internal `c_…` id for the whole run; proven end-to-end through real runCycle() calls on an isolated temp store (all 4 rekey paths exercised).
- Item 9 done: ONE shared DEFAULT_SYMBOLS (src/core/symbols.ts) now feeds the symbols route, status route AND cycle engine — fresh deployments show and trade the same DOT/BTC/ETH; live status endpoint verified returning the three defaults.
- Item 11 done: auth-credential vs account-API-key storage isolation locked by regression tests (20 checks) — login can never overwrite API keys and vice versa; reported bug not reproducible in current code.
---
Task ID: m4-chart
Agent: chart-signals
Task: Chart page signals box («سیگنال‌های اخیر») fully interactive — every signal clickable → jump-to-signal focus (owner item 4)

Work Log:
- Read worklog m3-fe-2c §7 contract + page.tsx shell flow, then scoped all edits to src/modules/chart/ChartView.tsx only
- Panel container: removed `pointerEvents:'none'`, added `data-chart-ui` (drawing hit-test now ignores the list, like the focus badge)
- ALL signals rendered (was slice(-6)): `signals.slice().reverse()` newest-first in the existing scroll column (maxHeight 168 / overflowY auto); each row is now `<button type="button">` full-width, hover `var(--bg-hover)`, border-radius 6, padding 4px 6px, disabled while loading; inner layout kept (icon + Long/Short + price + TP/SL + status badge)
- Row hover/disabled/pending styles ship via a React-hoisted `<style href="tb-sig-row">` (globals.css is off-limits — owned by parallel agents); backgrounds live in the sheet so :hover isn't shadowed by inline styles; pending row keeps 1px dashed var(--warning) + warning-soft tint (data-pending attr)
- Per-row compact Jalali time chip: fmtDateTime(s.signalConfirmedAt) (import added), split at ', ' → «۱۴۰۵/۰۷/۳۰ · ۰۱:۳۰», full value in row title; title/aria «نمایش سیگنال لانگ/شورت BTC در چارت — …» / «… در ساعت …»
- Hint line «برای پرش به سیگنال، روی ردیف کلیک کنید» (fontSize 9.5, muted, marginTop 6) at panel bottom
- Local focus path: `localFocus` state; focus-mirror effect now `focusRef.current = localFocus ?? focus ?? null` (still declared BEFORE the data-load effect); fresh non-null focus PROP clears localFocus — implemented with a VALUE-key comparison (signalTime+id+side) because the page shell rebuilds the focus payload object every render (identity churn from toast re-renders must not wipe an active local focus)
- focusSignal(s): guards candleOpenTime (finite/>0); targets the ANALYSIS interval — if different, handleIntervalChange(target, {keepLocalFocus:true}) + toast «بازه چارت / برای نمایش دقیق سیگنال، بازه چارت به <iv> تغییر کرد»; payload mirrors page.tsx (side/price/tp/sl guards + signalId); same-interval clicks bump reloadKey (no remount); history-prefetch path in the load effect handles pre-window signals unchanged
- Manual symbol/interval changes drop localFocus (setLocalFocus(null) in handleSymbolChange; keepLocalFocus flag on handleIntervalChange — explicit flag instead of relying on batched setLocalFocus(null)→set order, documented in code); handleBackToNow also clears localFocus
- Verified: tsc 0 errors, eslint clean, tests/chart-focus-url 21✓

Stage Summary:
- E2E (agent-browser, admin login → «چارت حرفه‌ای», BTC 1h): 7 rows rendered = badge count 7 (was 6); clicked OLDEST signal (Long ۱۴۰۵/۰۶/۲۴) → __tbChart.focusInfo {barTimeSec:1789477200, side:Long, price:76588.5}, visibleRange 1789189200..1789621200 CONTAINS the bar, history-prefetch klines request (startTime=1788577200000) fired, marker at bar, focus badge + «بازگشت به اکنون» appeared (VLM screenshot: green up-arrow at candle + badge); back-to-now returned focusInfo null + original latest-bars range 1792317600..1792782000
- Interval-switch path: chart on 15m/4h → click row → toast «برای نمایش دقیق سیگنال، بازه چارت به 1h تغییر کرد» shown, interval auto-switched to 1h, focus resolved; A→B row clicks switch focus without remount; manual interval change while locally focused drops the focus (focusInfo null, latest-bars centering); row hover = exactly rgb(241,245,249) (var(--bg-hover)); at 390px viewport panel (340px) fits inside chart wrap (366px) — VLM confirmed no overflow; dev.log tail clean, no console errors

---
Task ID: m4-frontend
Agent: orchestrator (main session)
Task: Items 1,2,3,6,7,8,10,12,13,14,15 of the owner's 15-item change list (frontend core + storage fix) — m4 round

Work Log:
- format.ts: NEW fmtTpsl (max 8 decimals, no minimum → trailing zeros trimmed: 0.1023000→0.1023, 12.0103200→12.01032); tpslLabel now uses fmtTpsl (was fmtPrice 2-dec). close-confirm tests updated+extended (33✓ incl. fmtTpsl cases).
- CloseConfirmDialog REDESIGNED (item 1): symbol banner (icon+symbol+side badge, side-tinted), 2×3 ccd-grid info cells (entry/mark/qty/leverage/margin/TP-SL full-precision), ccd-pnl highlight strip (pct + USDT SAME size), warning strip; safety semantics untouched (Escape/backdrop/انصراف = zero requests, submitting vetoes dismissal).
- NEW src/modules/automation/LogDetails.tsx (item 2): LogExpandedDetails — head (status badge+process+چرخه جاری), full-message box, meta chips (bold Jalali time, symbol, source, step, duration), cycle-id row + copy, «جزئیات فنی» grid with ~45-key Persian label dictionary + typed values (epoch-ms/ISO→bold Jalali .cell-dt, booleans→✓/✗ chips, controls[]→pass/fail chips with Persian control names, /Id$/→mono, numbers→formatted, objects→JSON block). AutomationView delegates renderLogDetails to it; local SOURCE_LABELS moved there.
- AutomationView layout (items 12+14): order = top-grid [نمادها|چرخه و رویدادها] → پوزیشن‌های باز (ABOVE market data) → داده بازار و سیگنال‌ها → NEW .bottom-grid [موجودی و ریسک | آمار معاملات نمادها] (2 cols ≥1100px, stacks below; kpi-grid-4 folds 2×2 inside). stats-inpage twin + old sidebar stats REMOVED (single in-page location now).
- Positions PnL cell (item 8): removed <small>/opacity — pct and (USDT) SAME size. Signals table (item 7): onRowClick REMOVED (rows not clickable); icon-only chart button remains the sole navigation. Date cells (item 3): NEW .cell-dt (font-weight 700, color var(--text-primary) → #0f172a light / #f1f5f9 dark) applied to log/symbols/signals tables + expanded chips.
- Sidebar (items 6/13/14): user-card footer + sidebar-stats REMOVED; NEW .sidebar-collapse-handle (floating, left edge, desktop-only) toggling body.sidebar-collapsed → 76px icon rail (labels/section-labels/badges hidden, icons centered), persisted tb-sidebar-collapsed; --sidebar-width var on body drives sidebar width AND main-content margin with one transition.
- AppHeader (item 13): «یک چرخه» button + */5 sched-pill REMOVED; NEW .header-user chip (avatar+name+caret, leftmost in RTL) with .user-menu dropdown (منبع: مدیر ربات + خروج از حساب; outside-click+Escape close). Footer cron badge removed from page.tsx.
- SettingsView (item 15): inner maxHeight/overflowY REMOVED — page is the single scrollbar.
- **CRITICAL FIX (item 9, second root cause)**: storage singleton was module-scoped — Next.js dev instantiates src/server/storage per API route → one adapter per route → writes from one route invisible to others until recompile (the owner's «symbols load late/don't show while data exists + already-exists error»). Singleton moved to globalThis.__TRADEBOT_STORAGE__ → ONE adapter/cache/write-queue runtime-wide. Proven: status route had lifetimeWrites:0 + stale symbols while file had fresh data; after fix status immediately returns lastCycleResult + fresh lastCycleTime.
- docs/STORAGE-MAP.md (item 10): full Persian data-location map (server KV keys vs localStorage keys) proving parity with the base version — important data server-side only.
- E2E (agent-browser, admin/admin123): layout order verified (6 panel titles in order); bottom-grid 559|486px; sidebar collapse 320→76→320 with margin follow + localStorage persist + VLM-verified screenshots (icon rail, no labels); user chip menu open/outside-click-close; symbols table shows DOT/BTC/ETH defaults (fresh db); run-cycle via UI → cycleId BTC_14050801_231509 (NEW FORMAT live), 32 log rows, summary chips (خطا/BTC/Jalali times/255ms/مراحل 5·1·2/بودجه), expanded row = translated labels (تعداد کل/بسته‌شده/…, boolean خیر chip, bold Jalali ۱۴۰۵/۰۸/۰۱, ۲۲:۳۰:۰۰); MOCKED position (network route, zero real orders): PnL «+4.8٪ (+0.26 USDT)» same size, TP 0.1023 / SL 12.01032 (exact owner examples), dialog renders banner+grid+pnl strip (VLM PASS), Escape = 0 close-requests; signals icon→chart: URL ?chart=BTC&interval=1h&focus=1792616400000&side=Short, focusInfo + visibleRange contains bar; chart signals-box: clicked 36-day-old Long row → chart jumped to 1789477200 with history prefetch (item 4 re-verified after rewiring); settings 1280/1024: inner overflowY visible/maxHeight none (no double scrollbar); mobile 390: no h-overflow, bottom-grid stacked, drawer + Escape, collapse handle hidden; dark theme .cell-dt = rgb(241,245,249) bold 700, light = rgb(15,23,42) bold 700.
- Gates: tsc 0 · eslint 0 · bun run test 10 suites / 241 checks ALL GREEN · dev.log clean (no runtime/hydration errors).

Stage Summary:
- Items 1,2,3,6,7,8,10,12,13,14,15 DONE (plus 4,5,9,11 by m4-chart/m4-server subagents). All 15 owner items complete and E2E-verified.
- KEY DISCOVERY: per-route storage singletons in dev (globalThis fix) — this was the real «symbols don't show» bug; recommend noting in delivery report.
- Sandbox db was reset before this round (only auth_credentials survived): test cycles ran WITHOUT exchange credentials (order-safe); owner must re-enter API keys in تنظیمات.
