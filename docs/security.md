# امنیت

## احراز هویت
- کوکی نشست `tb_session` = `username:expiry:issuedAt:HMAC-SHA256` (HttpOnly, SameSite=Strict, 7 روز)
- رمز عبور: SHA-256 شور‌دار (salt تصادفی) در `automationState:auth_credentials`
- تأسیس اعتبارنامه: از متغیرهای `AUTH_USERNAME`/`AUTH_PASSWORD`؛ در توسعه، ورود اول ثبت می‌کند
- تغییر اعتبارنامه `issuedAt` را تازه می‌کند → سایر نشست‌ها باطل می‌شوند
- **همه** مسیرهای حساس (سفارش/تنظیمات/دیباگ/چرخه) با `requireAuth` محافظت می‌شوند

## کرون
`POST /api/internal/cron` فقط با هدر `X-Cron-Secret == CRON_SECRET` (سرور-به-سرور).

## کلیدهای صرافی
- ذخیره فقط در سمت سرور (`automationState:settings_apiKeys`)
- GET تنظیمات کلیدها را ماسک می‌کند (`XXXX••••XXXX`) — هرگز کامل بازنمی‌گردد
- ورودی خالی = «حفظ مقدار فعلی» — مقدار ماسک‌شده هرگز ذخیره نمی‌شود
- `baseUrl` ثابت allow-list (کلاینت نمی‌تواند مقصد درخواست را عوض کند) — رفع باگ تنظیم‌سازی مرجع
- **هیچ کلید هاردکدی وجود ندارد** (رفع نشت کلید تولید نسخه قدیم)

## رفع‌شده نسبت به مرجع
| مشکل مرجع | راهکار v2 |
|---|---|
| کلیدهای API در HTML/LocaleStorage/هدرها | فقط KV سرور + ماسک |
| مسیرهای trading/settings/db بدون احراز هویت | requireAuth روی همه |
| secret پیش‌فرض ثابت AUTH_SECRET | env + هشدار setup |
| رمز عبور unsalted | SHA-256 شور‌دار |
| کوکی‌های قدیمی پس از تغییر رمز معتبر | ابطال با issuedAt |
| admin/admin پیش‌فرض عمومی | bootstrap از env یا ورود اول (فقط توسعه) |

## محرمانه‌ها (Production)
`AUTH_SECRET`, `CRON_SECRET`, و در Worker: `RUN_CYCLE_SECRET`.
هیچ‌کدام در لاگ/پاسخ API ظاهر نمی‌شوند.
