# بودجه عملیات ذخیره‌سازی

## کلیدها
| کلید | نوع | سقف |
|---|---|---|
| automationState:automation_settings | object | — |
| automationState:settings_apiKeys | object | — |
| automationState:automation_symbols | array | — |
| automationState:auth_credentials | object | — |
| automationState:lastCycleResult | object | — |
| automationState:cycleLock | object (TTL) | 90s |
| automationState:lastPositionCloseTime | number | — |
| automationState:pendingBaleMessages | array | 50 |
| logs | array | 500 |

## چرخه معمول (بدون معامله)
| عملیات | خواندن | نوشتن |
|---|---|---|
| تنظیمات+نمادها | 3 | 0 |
| قفل | 1 | 1 |
| symbols (آغاز) | 0 | 1 (stage→diff) |
| پایان | 0 | 0-1 (فقط اگر تغییر) |
| lastCycleResult+logs | 2 | 2 |
| **جمع** | **6-7** | **~3-5** |

کرون ۵ دقیقه‌ای → ~864 نوشتن/روز (زیر حد 1,000 پلن رایگان KV).

## ابزار اندازه‌گیری
- شمارنده لحظه‌ای چرخه: در خروجی هر CycleResult (`storage.reads/writes`)
- شمارنده طولانی‌مدت: `GET /api/diagnostics/storage`
- WriteBatcher: مقایسه ساختاری پایدار — نوشتن فقط در صورت تغییر واقعی

## ریسک هم‌زمانی آرایه‌ها
بازخوانی-تغییر-بازنویسی آرایه logs در KV اتمیک نیست؛ در Adapter محلی صف سریال جلوی گم‌شدن
نوشتن را می‌گیرد. در KV واقعی، پنجره رقابت با کادنس کرون و قفل چرخه محدود شده است.
مهاجرت آتی به D1/Durable Object از طریق همان `KVStore` interface ممکن است.
