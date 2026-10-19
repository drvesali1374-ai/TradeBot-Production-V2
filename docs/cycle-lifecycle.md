# چرخه عمر سیگنال و چرخه معاملاتی

## ماشین حالت شکست (Fake Breakout)
```
Idle → Break (شکست معنادار: عبور سطح روز قبل ± ATR×ضریب)
     → Waiting Recovery (عمر: breakSequenceLifetime || lookback کندل)
     → Recovery (بازگشت close به داخل سطح؛ شکست+بازیابی می‌تواند یک کندلی باشد)
     → Signal (فیلترها: حجم > میانگین×ضریب، RSI آستانه، HTF)
     → Reset (شکست مصرف می‌شود — چه سیگنال بیاید چه نیاید)
```
- شکست مخالف، شکست در انتظار را **جایگزین** می‌کند؛ شکست هم‌جهت دوباره نادیده گرفته می‌شود
- سطوح روزانه: نیمه‌شب تهران (UTC+3:30 ثابت)
- روش تشخیص: Wick (پیش‌فرض) یا Close

## وضعیت سیگنال
`PENDING` (آخرین، بدون پر شدن هم‌جهت) → `OPENED` (پر شدن هم‌جهت در بازه تا سیگنال بعدی)
| `EXPIRED` (بیش از signalExpirationHours) | `NOT_OPENED` (قدیمی‌تر بدون پر شدن)

## زمان‌های تفکیک‌شده
`candleOpenTime` · `candleCloseTime` · `signalConfirmedAt` (= بسته شدن کندل تأیید)
· `executionRequestedAt` · `orderSubmittedAt` — نمایش‌ها هرگز زمان باز شدن کندل را
«زمان تأیید سیگنال» جا نمی‌زنند (رفع ابهام نسخه مرجع).

## شناسه‌ها
- سیگنال: `{SYMBOL}_{LONG|SHORT}_{candleOpenTime}_v{STRATEGY_VERSION}` — پایدار و idempotent
- clientOrderId سفارش = شناسه سیگنال → اجرای مجدد چرخه سفارش تکراری تولید نمی‌کند
