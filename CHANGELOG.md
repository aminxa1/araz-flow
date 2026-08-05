# Araz Flow 2.0.0 — Build 003

## رفع بحرانی
- رفع Race Condition در ذخیره‌سازی Build 002.
- localStorage اکنون در همان لحظه ثبت/ویرایش داده نوشته و کنترل می‌شود.
- هنگام pagehide و visibilitychange یک ذخیره اضطراری همگام انجام می‌شود.
- شماره Cache سرویس‌ورکر برای دریافت قطعی Build جدید تغییر کرد.

## حفظ‌شده از Build 002
- IndexedDB
- ذخیره دوگانه
- Snapshot اضطراری
- Backup / Restore
- تست سلامت ذخیره‌سازی
