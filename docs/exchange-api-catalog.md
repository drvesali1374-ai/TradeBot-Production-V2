# کاتالوگ API توبیت (استخراج‌شده از کد مرجع — audit-3)

## پایه
- Base: `https://api.toobit.com` (ثابت)
- هدر کلید: `X-BB-APIKEY`
- امضا: HMAC-SHA256(hex) روی کوئری مرتب‌شده (کلید+مقدار encodeURIComponent) — `server/exchanges/toobit/signing.ts`
- GET امضاشده: `?{qs}&signature={hex}` | POST: body=x-www-form-urlencoded `{qs}&signature={hex}`
- Timeout همه فراخوانی‌ها: 12s (مرجع هیچ timeout نداشت)
- فرمت نماد: `{SYM}-SWAP-USDT` (تابع `fullSymbol`)

## Endpointها
| متد کتابخانه | Endpoint | نوع | recvWindow |
|---|---|---|---|
| getKlines | GET /quote/v1/klines?symbol&interval&limit | عمومی | — |
| getTickerPrice | GET /quote/v1/ticker/price?symbol | عمومی | — |
| getBalance | GET /api/v1/futures/balance | امضاشده | 60000 |
| getOpenPositions | GET /api/v1/futures/positions | امضاشده | 5000 |
| getHistoryPositions | GET /api/v1/futures/historyPositions | امضاشده | 60000 |
| getUserTrades | GET /api/v1/futures/userTrades | امضاشده | 5000 (کوئری دستی: symbol,limit,recvWindow,timestamp) |
| setLeverage | POST /api/v1/futures/leverage | امضاشده | 60000 |
| openPosition→order | POST /api/v1/futures/order | امضاشده | 60000 |
| closePosition→order | POST /api/v1/futures/order | امضاشده | 60000 |
| setTradingStops | POST /api/v1/futures/position/trading-stop | امضاشده | 60000 |

## الگوی سفارش ( حفظ رفتار صرافی)
`type: LIMIT + priceType: MARKET` بدون فیلد price.
- باز کردن: side = BUY_OPEN (لانگ) / SELL_OPEN (شورت)
- بستن: SELL_CLOSE (بستن لانگ) / BUY_CLOSE (بستن شورت)
- مقدار (قرارداد): `ceil(مارجین×اهرم / (قیمت×0.11))` — CONTRACT_SIZE=0.11

## TP/SL (trading-stop)
`takeProfit + tpTriggerBy=CONTRACT_PRICE` و `stopLoss + slTriggerBy=CONTRACT_PRICE`.
در v2 نتیجه TP/SL **بررسی و گزارش** می‌شود (در مرجع بی‌صدا نادیده گرفته می‌شد).

## نرمال‌سازی پاسخ‌ها
- موجودی: آرایه/`data`/`result`/`balances` → ردیف USDT → total=balance, available=availableBalance, free=available−orderMargin
- پوزیشن‌ها/تاریخچه: آرایه/`data`/`result`
- قیمتی: `data[0].p` یا `data.price|p`
