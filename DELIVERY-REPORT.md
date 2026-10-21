# گزارش تحویل — TradeBot-Production-V2 (مأموریت اصلاح ۱۰ فازی)

> این گزارش هر معیار پذیرش را با شواهد مستقیم (تست، خروجی ابزار، بررسی مرورگر) پشتیبانی می‌کند — نه با صرف ادعا.

---

## ۱) فهرست فایل‌های تغییرکرده

| فایل | تغییر | فاز |
|---|---|---|
| `.env`، `db/trading_data.json`، `db/custom.db` | حذف از تاریخچه Git (filter-branch) + untrack؛ فایل‌های runtime روی دیسک باقی مانده‌اند | ۰ |
| `.gitignore` | الگوهای `/db/*.json`، `/db/*.db`، `*.sqlite` + نفی‌های fixture (`.env.example`) | ۰ |
| `.env.example` (جدید) | نمونه ساختگی متغیرهای محیط | ۰ |
| `db/trading_data.example.json` (جدید) | نمونه ساختگی ساختار داده | ۰ |
| `tests/fixtures/toobit-positions.sample.json` (جدید) | ۷ حالت Fixture برای تست نگاشت PnL (بدون هیچ داده واقعی) | ۰/۱ |
| `tests/pnl-mapping.test.ts` (جدید) | تست پذیرش نگاشت PnL (`bun run test:pnl`) | ۱/۸ |
| `src/server/exchanges/toobit/client.ts` | حذف demoEngine؛ گارد `requireCredentials`؛ `normalizePosition`/`normalizeHistoryPosition` به‌عنوان تنها محل تبدیل (کسری×۱۰۰، null-safe) | ۶/۱ |
| `src/server/exchanges/toobit/demo.ts` | **حذف کامل فایل** | ۶ |
| `src/server/exchanges/toobit/index.ts` | حذف خروجی demoEngine/ToobitMode | ۶ |
| `src/core/types/index.ts` | حذف `CycleResult.demo`؛ فیلدهای nullable پوزیشن؛ `LogRecord` توسعه‌یافته (process/source/durationMs/step) | ۶/۱/۲ |
| `src/core/risk/controls.ts` | PRICE_DISTANCE با ورودی null به‌صورت صادقانه («قابل ارزیابی نیست») | ۱ |
| `src/server/automation/cycle-engine.ts` | حذف ctx.log تکراری؛ گام هشدار اعتبارنامه؛ persistCycleOutcome یکپارچه (steps→records، ۱ put) | ۲/۶ |
| `src/server/automation/cycle-context.ts` | حذف متد log (steps = جریان رویداد مرجع) | ۲ |
| `src/server/storage/storage-interface.ts` | حذف کلید demoState | ۶ |
| `src/app/api/account/balance`, `positions/open`, `positions/close`, `diagnostics/history` | حذف mode؛ انتشار `code` خطا (NO_CREDENTIALS با HTTP 200 + success:false) | ۶ |
| `src/app/api/market/analysis/route.ts` | اصلاح کامنت/رفتار (بدون ساختگی‌سازی) | ۶ |
| `src/modules/common/DataTable.tsx` (جدید) | کامپوننت مشترک جدول (تک جدول واقعی، colgroup، sticky thead، ردیف بسط‌یافته) | ۱/۲ |
| `src/modules/automation/AutomationView.tsx` | بازنویسی کامل: کارت نماد اول، چیپ‌های RTL سیگنال، جدول لاگ تمام‌عرض با فیلترها/کپی، حذف Demo، «—» برای نامشخص | ۱/۲/۳/۴/۶ |
| `src/modules/layout/AppHeader.tsx` | sched-pill (بدون معنای Demo) | ۶ |
| `src/modules/layout/Sidebar.tsx` | حذف داشبورد/نشان Demo/حالت آزمایشی؛ قفل اسکرول drawer | ۷/۶/۵ |
| `src/app/page.tsx` | حذف داشبورد + demoMode؛ نمای پیش‌فرض automation | ۷/۶ |
| `src/modules/dashboard/DashboardView.tsx` | **حذف کامل فایل** | ۷ |
| `src/modules/LoginView.tsx` | بازنویسی راهنمای راه‌اندازی اولیه (بدون «محیط آزمایشی») | ۶ |
| `src/app/globals.css` | قواعد th/td محدود به `.tb-table`؛ sticky header؛ شبکه minmax(360,380)؛ kpi-symbol؛ signal-meta؛ drawer z110/blur حذف؛ rفع cascade دکمه موبایل | ۱/۳/۴/۵ |
| `src/modules/common/format.ts` | قرارداد fmtUsd (۲ رقم اعشار پایدار) | ۱ |
| `next.config.ts` | حذف `output: standalone` و `ignoreBuildErrors` | ۸ |
| `package.json` | build=next build، build:pages، test:pnl | ۸ |
| `tsconfig.json` | محدود به src (زیرپروژه‌ها toolchain خود را دارند) | ۸ |
| `README.md`، `docs/*.md` | همسویی مسیر واحد Build، قرارداد PnL، حذف Demo | ۶/۸ |

---

## ۲) علت هر اصلاح مهم

1. **PnL (فاز ۱):** مستندات رسمی Toobit (رندر مرورگری) و کد پروژه مرجع هر دو تایید کردند که `profitRate`/`realizedPnlRate` **کسری** هستند (نمونه مستندات: `"pr":"0.003"`، `"realizedPnlRate":"0.0042"`، `"marginRate":"0.4992"` برای اهرم ۲؛ کد مرجع: `parseFloat(pos.profitRate||0)*100`). کد قبلی مقدار کسری خام را مستقیم به `fmtPct` می‌داد → **خطای ۱۰۰ برابری**. اکنون تبدیل فقط در `normalizePosition` (×۱۰۰) انجام می‌شود و `fmtPct` طبق قرارداد «واحد درصد» می‌گیرد — تست مستقر: `0.003 → +0.3٪`.
2. **فیلد نامعتبر/گمشده:** قبلاً `Number(p.profitRate ?? 0)` مقدار صفرِ ساختگی می‌ساخت. اکنون `toNum` سخت‌گیر است (حتی رشته خالی → null — این حالت توسط تست کشف شد) و UI «—» (نامشخص) نشان می‌دهد.
3. **`entryPrice` تاریخچه:** مستندات فیلد `openAvgPrice` را تعریف می‌کنند نه `avgPrice` — نگاشت اصلاح شد.
4. **جدول‌ها (فاز ۱):** قواعد سراسری `th/td` با اثر جانبی روی تمام جدول‌ها → محدود به `.tb-table`؛ `border-collapse: separate + spacing: 0` برای سازگاری sticky+اسکرول با خطوط ردیف پیوسته؛ سرستون sticky با پس‌زمینه غیرشفاف؛ تک جدول واقعی (نه دو جدول) → عدم امکان جداافتگی ستون‌ها.
5. **لاگ (فاز ۲):** قبلاً فقط ۳-۵ پیام سطح‌بالا با `action: automation_cycle` ذخیره می‌شد و `steps` (داده فنی واقعی) از دست می‌رفت. اکنون همه گام‌ها با نام فرایند واقعی، وضعیت منسجم، مدت و جزئیات پاک‌سازی‌شده ذخیره می‌شوند — **در یک عملیات نوشتن** (۲ put در کل چرخه؛ اندازه‌گیری واقعی: ۵ نوشتن کل چرخه).
6. **cycleId:** از بخش اطلاعات اصلی خارج و به جزئیات اجرا منتقل شد — با کپی (و نمایش شناسه در پیام خطا به‌عنوان جایگزین) و فیلتر «رویدادهای همین چرخه».
7. **دکمه موبایل (فاز ۵ — ریشه‌یابی):** `.icon-btn { display:flex }` در فایل **بعد از** `.mobile-toggle { display:none }` آمده بود؛ با تساوی specificity قانون بعدی برنده می‌شد → دکمه در دسکتاپ هم رندر می‌شد. رفع با سلکتور `.icon-btn.mobile-toggle` (اثبات با CSSOM مرورگر).
8. **Blur پس‌زمینه:** `backdrop-filter: blur(4px)` حذف شد (فقط تیرگی) و z-index سایدبار به ۱۱۰ بالا رفت تا منو به‌یقیت بالای Backdrop بماند + قفل اسکرول body هنگام باز بودن.
9. **Demo (فاز ۶):** هر مسیر شبیه‌سازی runtime حذف شد؛ نبود اعتبارنامه = خطای صریح قابل ردیابی (`NO_CREDENTIALS` / «اعتبارنامه صرافی تنظیم نشده است») — نه حساب ۱۰هزار دلاری ساختگی. داده عمومی بازار بدون کلید می‌ماند (طبق مستندات عمومی است).
10. **Build (فاز ۸):** `output: standalone` با مسیر رسمی مستندشده (Cloudflare Pages) تناقض داشت و `ignoreBuildErrors` خطاهای واقعی را می‌پوشاند — هر دو حذف شدند؛ `tsc --noEmit` اکنون واقعاً پاک است (۰ خطا در src).

---

## ۳) نتایج تست‌ها و Build

| بررسی | نتیجه |
|---|---|
| `npx tsc --noEmit` (کد محصول) | **۰ خطا** (exit 0) |
| `bun run lint` (eslint .) | **۰ خطا/هشدار** |
| `bun run test:pnl` | **همه PASS** — ۷ حالت Fixture (Long سود/زیان، Short سود/زیان، صفر، فیلد گمشده، فیلد نامعتبر) + قرارداد نمایش (`0.003→+0.3٪`، `$12.50`، «—»، سازگاری علامت) |
| E2E مرورگر (agent-browser) | صفحه ۲۰۰؛ بدون خطای کنسول؛ هدر sticky در هر ۳ نما (بالای هدر پس از اسکرول = 0px)؛ drawer موبایل باز/بسته (Escape/کلیک بیرون/انتخاب صفحه) با قفل اسکرول؛ سرستون sticky داخل کانتینر اسکرول (th top==container top، سطرها زیر آن)؛ فیلترها (وضعیت هشدار=۱۱ ردیف، جست‌وجو «منقضی»=۱۱، قیف چرخه)؛ جزئیات بسط‌یافته با کپی |
| چرخه واقعی بدون سفارش | نمادها همگی بدون سیگنال جدید (اثبات pre-check) → اجرای «یک چرخه» → پایان SIGNAL_EXPIRED **بدون هیچ فراخوانی امضاشده** → رویدادهای واقعی جدید در جدول لاگ (۶ گام) |
| بودجه KV | ۲۳ خواندن / ۵ نوشتن در کل چرخه (نوشتن لاگ تجمیعی = ۱) — در محدوده سند (۳-۵) |
| حسابرسی بصری (VLM) | دسکتاپ ۶/۶ ✅ (کارت نماد اول، RTL سیگنال، هم‌ترازی سرستون/داده، خطوط پیوسته، لاگ تمام‌عرض، بدون هم‌پوشانی)؛ موبایل: بدون برش/هم‌پوشانی، منو کاملاً مرئی بالای Backdrop |

توجه: `bun run build` طبق قواعد این محیط سندباکس اجرا نشد؛ مسیر Build رسمی در README/tsconfig مستند و با tsc پاک پشتیبانی می‌شود (`next build` ← `@cloudflare/next-on-pages` ← `wrangler pages deploy`).

---

## ۴) نتیجه بررسی محاسبه PnL

- **واحد API (تاییدشده):** `unrealizedPnL` = مبلغ USDT مستقیم؛ `profitRate` = **کسری** (Fraction) — سند رسمی + کد مرجع (`×100`).
- **باگ قبلی:** نمایش کسری خام به‌عنوان درصد (تا ۱۰۰ برابر کوچک‌تر؛ مثال سند: نمایش `0.003٪` به‌جای `0.3٪`).
- **رفع:** تبدیل در یک نقطه واحد (`normalizePosition`/`normalizeHistoryPosition`) ×۱۰۰ → قرارداد داخلی «واحد درصد» → `fmtPct` مستند شد. `CONTRACT_SIZE=0.11` فقط برای محاسبه تعداد قرارداد سفارش است و **هیچ نقشی در PnL زنده ندارد** (بررسی مستقیم کد).
- **مبلغ:** مستقیماً از فیلد صرافی؛ فیلد نامشخص = «—» نه صفر.
- **اثبات با Fixture:** ۷ حالت + نمایش — همه PASS (خروجی تست در §۳).

---

## ۵) نمونه Sanitized رویدادهای جدول لاگ (از اجرای واقعی چرخه `c_mvgog***`)

| زمان | نماد | فرایند | وضعیت | جزئیات (خلاصه) |
|---|---|---|---|---|
| ۰۷/۲۸، ۱۲:۴۶ | DOT | بارگذاری تنظیمات | موفق | «تنظیمات و 3 نماد بارگذاری شد» — KV: settingsVersion, hasCredentials |
| ۰۷/۲۸، ۱۲:۴۶ | DOT | قفل اجرا | موفق | «قفل اجرا فعال شد» |
| ۰۷/۲۸، ۱۲:۴۶ | DOT | انتخاب نماد | موفق | «نماد DOT انتخاب شد» — مدت: ۰ms |
| ۰۷/۲۸، ۱۲:۴۶ | DOT | داده بازار | موفق | «1000 کندل دریافت شد (999 بسته‌شده)» |
| ۰۷/۲۸، ۱۲:۴۶ | DOT | محاسبات و سیگنال | موفق | «2 سیگنال در تاریخچه تحلیل تولید شد» |
| ۰۷/۲۸، ۱۲:۴۶ | DOT | انتخاب سیگنال | رد/ردشده | «سیگنالی برای بررسی وجود ندارد» |

(کلیدهای حساس با regex `secret|password|token|apikey` پیش از ذخیره حذف می‌شوند — تابع `sanitizeStepData`.)

---

## ۶) Sticky Header و منوی موبایل

- **Sticky header:** یک پیاده‌سازی مشترک `.top-header { position: sticky; top: 0; z-index: 80 }` با پس‌زمینه غیرشفاف و full-bleed (`--content-pad-x` واکنش‌گرا) در هر ۳ نما (اتوماسیون/چارت/تنظیمات). اندازه‌گیری مرورگر: پس از اسکرول ۹۰۰px بالای هدر = 0px و مرئی. z-index 80 زیر drawer (۱۱۰)، Backdrop (۹۹)، مودال (۲۰۰۰) و توست (۱۰۰۰) → هیچ پوشش‌گذاری معکوس رخ نمی‌دهد.
- **منوی موبایل:** با فشردن دکمه (فقط ≤1024px مرئی — ریشه cascade رفع و اثبات شد) منو با `translateX(0)` کاملاً مرئی می‌شود (اندازه‌گیری: چپ=118، عرض=272، visibleOnScreen=true)، Backdrop فعال و تیره (بدون blur)، اسکرول body قفل. بستن با: Escape ✅، کلیک روی Backdrop ✅، انتخاب صفحه ✅. حسابرسی تصویری VLM: منو کاملاً بالای پس‌زمینه تیره، بدون خرابی چیدمان.

---

## ۷) گزارش اصلاح Demo و داشبورد

- **Demo:** `demo.ts` حذف شد؛ مسیرهای fallback در client حذف؛ همه Badgeها/برچسب‌های UI (نتیجه چرخه، پنل موجودی، لوگو Sidebar، بخش کاربر، Footer، راهنمای ورود) حذف/بازنویسی شدند؛ فیلد `demo` از `CycleResult` و کلید `demo:exchange_state` از KV حذف شدند؛ اعلان‌های بله بدون پسوند «محیط آزمایشی». نبود کلید = پیام «اعتبارنامه صرافی تنظیم نشده است» (کد `NO_CREDENTIALS`) در UI و توقف صریح عملیات حساب/سفارش.
- **داشبورد:** از ناوبری حذف؛ `ViewId = automation | chart | settings`؛ نمای پیش‌فرض بعد از ورود = اتوماسیون؛ `DashboardView.tsx` حذف فیزیکی؛ دکمه «یک چرخه» فقط در اتوماسیون (هدر + داخل پنل).
- **باقیمانده منطقی:** صفر تغییر در منطق سیگنال/ورود/خروج/ریسک به‌جز موارد صادقانه‌سازی null (PRICE_DISTANCE).

---

## ۸) وضعیت نهایی امنیت و Build/Deployment

**امنیت فایل‌های محلی:**
- تاریخچه Git در سطح blob پاک‌سازی شد: هیچ آبجکتی با `.env`/`trading_data.json`/`custom.db` در تاریخچه قابل‌دسترس نیست (بررسی `git rev-list --all --objects` — فقط fixture نمونه باقی است). **توجه:** پاک‌سازی تاریخچه محلی کامل است؛ برای اعمال روی GitHub به force-push نیاز است (توکن در این جلسه ارائه نشده — پس از دریافت انجام می‌شود).
- فایل‌های واقعی runtime روی دیسک باقی‌اند (untracked + ignore شده)؛ نسخه پشتیبان امن در `/home/z/tb-backup/` (مجوز 0700).
- **مهم:** حذف از Git جایگزین **ابطال/تعویض کلیدها در پنل Toobit و بله** نیست — این اقدام بر عهده مالک است (چون مقادیر قبلاً در تاریخچه عمومی بوده‌اند، تعویض کلید API/Secret/توکن بله توصیه اکید است).
- اسکن متن کل درخت ردیابی‌شده: هیچ مقدار محرمانه‌ای در سورس/مستندات نیست (`redactAccountSettings` کلیدها را در API ماسک می‌کند؛ لاگ‌ها pre-sanitize می‌شوند).

**Build و استقرار (یک مسیر رسمی):**
```bash
bun install
bun run dev            # توسعه :3000
bun run test:pnl       # تست بدون سفارش واقعی
npx tsc --noEmit && bun run lint
bun run build          # Build استاندارد
bun run build:pages    # تبدیل Cloudflare Pages → npx wrangler pages deploy
cd cloudflare/scheduler && npx wrangler deploy   # کرون‌ورکر */۵ (X-Cron-Secret)
```
`output: standalone` و `ignoreBuildErrors` حذف شدند؛ محیط‌های تست (fixtures/mocks در `tests/`) از مسیر runtime محصول جدایی کامل دارند.

---

## معیارهای پذیرش نهایی — وضعیت

| معیار | وضعیت | شواهد |
|---|---|---|
| سرستون/ستون منطبق در همه جدول‌ها | ✅ | تک جدول واقعی + colgroup؛ VLM 6/6 |
| سرستون هنگام اسکرول ثابت | ✅ | اندازه‌گیری th==container top |
| خطوط ردیف پیوسته/یکنواخت | ✅ | separate+spacing:0؛ VLM |
| جدول نمادها فضای کافی | ✅ | minWidth 320→430 (اندازه‌گیری عرض واقعی) |
| پنل لاگ عرض اصلی | ✅ | 952px == عرض محتوا |
| کارت نماد اولین کارت | ✅ | DOM + VLM (همسو با سلکتور) |
| RTL متن سیگنال آماده | ✅ | چیپ‌های bdi ایزوله؛ VLM |
| هدر ثابت در تمام نماها | ✅ | ۳/۳ rect=0 |
| منوی موبایل باز/بسته صحیح | ✅ | ۳ مسیر بستن اثبات‌شده |
| بدون داشبورد در ناوبری | ✅ | ۳ آیتم |
| PnL منطبق با پاسخ واقعی Toobit | ✅ | مستندات رسمی + تست |
| درصد بر اساس قرارداد تست‌شده | ✅ | کسری×۱۰۰ واحد داخلی |
| فیلد گمشده ≠ صفر ساختگی | ✅ | «—» + تست |
| فرمت Long/Short آزمایش‌شده | ✅ | ۷ حالت Fixture PASS |
| رویداد واقعی مراحل چرخه در جدول | ✅ | ۶ رویداد از چرخه واقعی |
| ستون‌های زمان/نماد/فرایند/وضعیت/جزئیات | ✅ | DOM |
| cycleId در جزئیات + کپی | ✅ | کلیک/توست اثبات |
| علت رد/خطا قابل ردیابی | ✅ | details KV هر گام |
| ذخیره تجمیعی لاگ (نه per-step) | ✅ | ۵ نوشتن کل چرخه |
| بدون Demo در UI/runtime | ✅ | حذف کامل + خطای صریح |
| توقف عملیات بدون اعتبارنامه | ✅ | گارد NO_CREDENTIALS |
| بدون محرمانه در Git/لاگ/Fixture/API | ✅ | اسکن + پاک‌سازی تاریخچه (محلی) |
| تفکیک تست/Production | ✅ | fixtures در tests/، runtime تمیز |
| تست بدون سفارش واقعی | ✅ | کل E2E بدون سفارش |

**باقیمانده (نیازمند مالک):** ۱) ارائه PAT برای force-push تاریخچه پاک‌شده به GitHub؛ ۲) تعویض/ابطال کلیدهای لو رفته در پنل صرافی و بله.
