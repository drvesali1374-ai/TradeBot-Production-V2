# آزمایش و استقرار

## سه حالت محیط
1. **توسعه سریع** — `bun run dev` :3000، Storage فایل محلی (db/trading_data.json)،
   داده بازار عمومی واقعی (بدون کلید). عملیات حساب/سفارش بدون اعتبارنامه با خطای
   صریح «اعتبارنامه صرافی تنظیم نشده است» متوقف می‌شود (هیچ داده ساختگی‌ای
   نمایش داده نمی‌شود). ورود اول = ثبت اعتبارنامه مدیر.
2. **یکپارچگی نزدیک کلود** — `npx wrangler pages dev` با binding KV آزمایشی
   (`TRADING_DATA`)؛ Adapter به‌طور خودکار سوئیچ می‌کند (وجود `globalThis.__TRADING_KV__`).
   کلیدهای آزمایشی را از env بدهید.
3. **Production** — Pages + Cron Worker + Secretهای واقعی.

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
- قفل هم‌زمانی ✓ · تفکیک زمان‌ها ✓ · ردیابی cycleId در جدول لاگ + کپی ✓

## آزمون‌های خودکار (بدون ارسال سفارش)
- `bun run test:pnl` — نگاشت PnL با Fixtureهای Sanitized
  (Long/Short سود/زیان، صفر، فیلد گمشده/نامعتبر، تبدیل کسر→درصد 0.003→+0.3٪)

## Build رسمی (یک مسیر واحد)
- Build: `bun run build` (بدون ignoreBuildErrors — خطاهای TypeScript واقعاً رفع شده‌اند؛ `npx tsc --noEmit` پاک است)
- استقرار Cloudflare: `bun run build:pages` سپس `npx wrangler pages deploy`
- استقرار Cron Worker: `cd cloudflare/scheduler && npx wrangler deploy`

## آزمون‌های دستی پیش از Production
- اجرای «یک چرخه» با کلیدهای واقعی (حداقل مارجین) و بررسی سفارش در پنل صرافی
- بررسی رد ریسک‌ها با موجودی کم → اعلان‌های بله با قیاس ریاضی
- هم‌زمانی: فشار دستی در لحظه کرون → رد قفل
- انقضای سیگنال و سیگنال تکراری (idempotency)
