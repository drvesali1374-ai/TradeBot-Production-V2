# 🤖 TradeBot-Production-V2

نسخه‌ی بازطراحی‌شده و بازنویسی‌شده‌ی **ربات معاملاتی تریدبات** — ساخته‌شده کاملاً طبق «دستورالعمل نسخه جدید»، با معماری ماژولار، تم اختصاصی داشبورد، و راه‌حل ذخیره‌سازی دوگانه (فایل محلی / Cloudflare KV).

> 📌 این مخزن جایگزین کامل [TradeBot-Production](https://github.com/drvesali1374-ai/TradeBot-Production) است؛ کل موتور، ذخیره‌سازی، احراز هویت و رابط کاربری از صفر بازنویسی شده‌اند.

---

## ✨ امکانات

### رابط کاربری (تک‌صفحه‌ای SPA با ۴ نما)
- **داشبورد** — ارزش حساب، سود/زیان، پوزیشن‌های باز، نرخ برد، تاریخچه و آخرین فعالیت‌ها
- **اتوماسیون** — اجرای دستی چرخه، وضعیت نمادها (BTC/ETH/DOT/SOL/BNB/XRP/DOGE/ADA/AVAX/LINK)، نتیجه‌ی ۱۴ مرحله‌ای هر چرخه
- **چارت حرفه‌ای** — کندل‌استیک + حجم + RSI (lightweight-charts)، مارکر سیگنال، خطوط TP/SL/Entry، ۶ ابزار رسم (خط افقی/عمودی/روند/اندازه‌گیری/حذف/پاک‌سازی)، تم دوگانه
- **تنظیمات** — ۳ تب و ۷ گروه پارامتر استراتژی + مدیریت کلید API + ارسال تست بله
- تم روشن/تاریک، RTL کامل با فونت Vazirmatn، واکنش‌گرا (موبایل/دسکتاپ)، آیکون‌های Phosphor

### موتور معاملاتی (چرخه‌ی ۱۴ مرحله‌ای)
- قفل اجرا (TTL 90s) برای جلوگیری از هم‌پوشانی کرون و اجرای دستی
- استراتژی **Fake Breakout** با سطوح روزانه (نیمه‌شب تهران) + حالت legacy
- RSI (اصلاح‌شده)، ATR، SMA با فیلتر صریح کندل بسته
- تأیید چندتایم‌زون (HTF) پیش از تأیید سیگنال
- ۶ کنترل ریسک (مارجین، حجم، حد ضرر و…) با دلیل ریاضی رد
- شناسه‌ی سیگنال پایدار برای idempotency سفارش‌ها + تفکیک کامل مهرهای زمانی

### ذخیره‌سازی (هسته‌ی سبک KV با بودجه‌ی نوشتن)
| حالت | آداپتور | کاربرد |
|---|---|---|
| فایل محلی | `LocalKVAdapter` → `db/trading_data.json` | توسعه/سندباکس |
| Cloudflare KV | `CloudflareKVAdapter` | استقرار ابری |

- **صف سریال نوشتن** + نوشتن اتمیک (tmp + rename) — بدون گم‌شدن/خرابی داده
- **WriteBatcher** با مقایسه‌ی ساختاری — نوشتن فقط هنگام تغییر واقعی (~۳-۵ نوشتن در هر چرخه؛ زیر سقف ۱۰۰۰ نوشتن روزانه‌ی پلن رایگان KV)
- شمارنده‌ی لحظه‌ای و طولانی‌مدت خواندن/نوشتن در `/api/diagnostics/storage`

### صرافی و امنیت
- اتصال به **Toobit** (کندل/تیکر عمومی + امضای HMAC برای سفارش‌ها)
- **بدون اعتبارنامه صرافی**: داده‌ی بازار عمومی کار می‌کند؛ هر عملیات حساب/سفارش با خطای صریح «اعتبارنامه صرافی تنظیم نشده است» متوقف می‌شود (بدون هیچ داده‌ی ساختگی — حالت Demo از محصول حذف شده است)
- احراز هویت کوکی امضاشده (HMAC-SHA256) + رمز عبور شور‌دار + ابطال نشست هنگام تغییر رمز
- اعلان **بله** با صف پیام‌های معوق (سقف ۵۰)
- همه‌ی مسیرهای حساس API محافظت‌شده

---

## 🚀 راه‌اندازی

```bash
# نصب وابستگی‌ها
bun install

# اجرای توسعه (پورت 3000)
bun run dev
```

سپس `http://localhost:3000` را باز کنید.

**ورود (محیط تست):** `admin` / `admin123` — از نمای تنظیمات قابل تغییر است.
> در استقرار واقعی، `AUTH_USERNAME` و `AUTH_PASSWORD` را به‌عنوان متغیر محیطی تنظیم کنید و `AUTH_ALLOW_SETUP` را فعال نگذارید.

### متغیرهای محیطی
| متغیر | توضیح |
|---|---|
| `AUTH_SECRET` | رمز امضای کوکی نشست (الزامی در تولید) |
| `AUTH_USERNAME` / `AUTH_PASSWORD` | اعتبارنامه‌ی اولیه |
| `TB_DATA_FILE` | مسیر فایل ذخیره‌سازی محلی (پیش‌فرض `db/trading_data.json`) |
| `X_CRON_SECRET` | رمز مشترک مسیر `/api/internal/cron` |
| `DATABASE_URL` | Prisma (اختیاری برای ابزارهای کمکی) |

---

## 🏗 ساختار پروژه

```
src/
├── app/
│   ├── page.tsx                # SPA تک‌صفحه‌ای (داشبورد/اتوماسیون/چارت/تنظیمات + دروازه ورود)
│   └── api/                    # مسیرهای API (Node runtime)
│       ├── auth/               # login / logout / verify / update-credentials
│       ├── automation/         # run-cycle / status / symbols
│       ├── market/             # klines / ticker / analysis
│       ├── positions/          # open / close
│       ├── account/            # balance
│       ├── settings/           # خواندن/نوشتن تنظیمات + تست بله
│       ├── diagnostics/        # logs / storage / history
│       └── internal/cron       # ورودی کرون‌ورکر ابری
├── core/                       # محاسبات خالص: اندیکاتورها، استراتژی، سیگنال، ریسک، زمان
├── server/
│   ├── storage/                # KVStore + LocalAdapter + CloudflareAdapter + WriteBatcher
│   ├── exchanges/toobit/       # کلایننت واحد + امضا + موتور دمو
│   ├── automation/              # موتور چرخه + قفل + context
│   ├── auth/                   # نشست کوکی + اعتبارنامه‌ها
│   └── notifications/          # بله
├── modules/                    # React UI (نماها، چارت، تنظیمات، قالب)
└── components/ui/              # شادکن/تیلویند
cloudflare/scheduler/           # کرون‌ورکر */۵ → /api/internal/cron
db/trading_data.json            # ذخیره‌سازی محلی (KV مسطح)
docs/                           # معماری، امنیت، چرخه، بودجه ذخیره‌سازی، کاتالوگ API
prisma/                         # اسکیمای Prisma
```

---

## ☁️ استقرار ابری (Cloudflare)

۱. پروژه را در Cloudflare Pages/Workers مستقر کنید و namespace `TRADING_DATA` (KV) را bind کنید — با وجود binding، آداپتور Cloudflare به‌صورت خودکار فعال می‌شود.
۲. کرون‌ورکر `cloudflare/scheduler` را با cadence `*/5` منتشر کنید تا `/api/internal/cron` (با هدر `X-Cron-Secret`) را فراخوانی کند.
۳. متغیرهای محیطی (`AUTH_SECRET` و…) را در داشبورد تنظیم کنید.

---

## 🧾 قرارداد داده‌ی سود/زیان (تأییدشده با مستندات رسمی Toobit)
- `unrealizedPnL` / `realizedPnL`: مبلغ مستقیم از صرافی (USDT)
- `profitRate` / `realizedPnlRate`: صرافی **کسری** می‌دهد (نمونه‌ی مستندات: `"0.003"`) — در `normalizePosition` (تنها محل تبدیل) ×۱۰۰ می‌شود تا قرارداد داخلی «واحد درصد» باشد → نمایش `+0.3٪`
- فیلد گمشده/نامعتبر → `null` → نمایش «—» (نامشخص)؛ هرگز صفرِ ساختگی نمایش داده نمی‌شود
- `fmtPct()` در ورودی «واحد درصد» می‌پذیرد — هیچ مقدار کسری بدون تبدیل به آن داده نمی‌شود
- `entryPrice` از `avgPrice` (پوزیشن‌ها) و `openAvgPrice` (تاریخچه) — طبق مستندات رسمی

## 🧾 جدول لاگ یکپارچه (فاز ۲)
- تمام مراحل هر چرخه به‌صورت رویدادهای واقعی (نام فرایند، وضعیت، جزئیات فنی، مدت) در **یک** آرایه‌ی KV ذخیره می‌شوند — یک عملیات نوشتن در هر چرخه، نه به‌ازای هر مرحله
- ستون‌ها: زمان | نماد | فرایند | وضعیت | جزئیات — با جست‌وجو، فیلتر نماد/وضعیت/چرخه، ردیفِ قابل‌بسط و کپی شناسه‌ی چرخه
- وضعیت‌ها: موفق / اطلاع‌رسانی / رد-ردشده / هشدار / خطا

## ✅ آزمون بدون سفارش واقعی
```bash
bun run test:pnl   # نگاشت PnL با Fixtureهای Sanitized (Long/Short، صفر، فیلد گمشده/نامعتبر)
npx tsc --noEmit   # خطاهای TypeScript واقعاً رفع شده‌اند — بدون ignoreBuildErrors
bun run lint
```

## 📦 Build و استقرار (یک مسیر رسمی)
```bash
bun run dev          # توسعه محلی :3000
bun run build        # Build استاندارد Next (Cloudflare Pages آن را مصرف می‌کند)
bun run build:pages  # تبدیل Cloudflare Pages → سپس: npx wrangler pages deploy
cd cloudflare/scheduler && npx wrangler deploy   # کرون‌ورکر */۵
```

---

## 📖 مستندات فنی
- [docs/architecture.md](docs/architecture.md) — معماری کلی
- [docs/cycle-lifecycle.md](docs/cycle-lifecycle.md) — چرخه‌ی ۱۴ مرحله‌ای
- [docs/storage-write-budget.md](docs/storage-write-budget.md) — بودجه‌ی نوشتن KV
- [docs/security.md](docs/security.md) — امنیت و احراز هویت
- [docs/exchange-api-catalog.md](docs/exchange-api-catalog.md) — کاتالوگ API توبیت
- [docs/testing-and-deployment.md](docs/testing-and-deployment.md) — تست و استقرار

## ⚠️ سلب مسئولیت
معامله‌گری خودکار در بازارهای کریپتو با ریسک همراه است. این پروژه صرفاً برای اهداف آموزشی/پژوهشی ارائه شده و مسئولیت هرگونه استفاده با کاربر است.

## 🛠 پشته‌ی فناوری
Next.js 16 (App Router) · TypeScript 5 · Tailwind CSS 4 · shadcn/ui · lightweight-charts · Zustand · Prisma · Phosphor Icons · Vazirmatn
