# آزمایش و استقرار

## سه حالت محیط (§9 دستورالعمل)
1. **توسعه سریع** — `bun run dev` :3000، Storage فایل محلی (db/trading_data.json)،
   داده بازار واقعی + حساب شبیه‌سازی‌شده (بدون کلید). ورود اول = ثبت اعتبارنامه.
2. **یکپارچگی نزدیک کلود** — `npx wrangler pages dev` با binding KV آزمایشی
   (`TRADING_DATA`)؛ Adapter به‌طور خودکار سوئیچ می‌کند (وجود `globalThis.__TRADING_KV__`).
   کلیدهای آزمایشی را از env بدهید.
3. **Production** — Pages + Cron Worker + Secretهای واقعی. فایل‌های دمو استفاده نمی‌شوند.

## استقرار
1. Pages: `npx @cloudflare/next-on-pages` سپس `npx wrangler pages deploy`
2. KV: `npx wrangler kv namespace create TRADING_DATA` و اتصال در wrangler.toml
3. Secrets: `wrangler secret put AUTH_SECRET` / `AUTH_USERNAME` / `AUTH_PASSWORD` / `CRON_SECRET`
4. Cron Worker: `cd cloudflare/scheduler && npx wrangler deploy` سپس
   `wrangler secret put RUN_CYCLE_SECRET` (deploy مخفی را پاک می‌کند — دوباره تنظیم کنید)
5. کرون هر ۵ دقیقه → `POST {APP_URL}/api/internal/cron` با `X-Cron-Secret`

## پذیرش (خلاصه §15)
- موتور واحد برای دستی/کرون ✓ · بدون Start/Stop ✓ · «یک چرخه» ✓
- بدون زمان‌بند مرورگر ✓ · کلیدها فقط سرور ✓ · شمارش R/W قابل مشاهده ✓
- قفل هم‌زمانی ✓ · تفکیک زمان‌ها ✓ · ردیابی cycleId در پنل ✓

## آزمون‌های دستی پیش از Production
- اجرای «یک چرخه» با کلیدهای واقعی (حداقل مارجین) و بررسی سفارش در پنل صرافی
- بررسی رد ریسک‌ها با موجودی کم → اعلان‌های بله با قیاس ریاضی
- هم‌زمانی: فشار دستی در لحظه کرون → رد قفل
- انقضای سیگنال و سیگنال تکراری (idempotency)
