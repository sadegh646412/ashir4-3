/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * اجرای بک‌تست استراتژی TrendPulse از خط فرمان، بدون نیاز به بالا آوردن سرور.
 *
 * نحوه‌ی استفاده:
 *   npx tsx scripts/run-backtest.ts BTC_USDT 5m 1000
 *
 * آرگومان‌ها (همه اختیاری):
 *   1) symbol    پیش‌فرض BTC_USDT
 *   2) interval  پیش‌فرض 5m
 *   3) limit     پیش‌فرض 1000 (حداکثر کندلی که صرافی برمی‌گرداند)
 */

import { XTClient } from "../src/lib/ashir/xtClient";
import { config as ashirConfig } from "../src/lib/ashir/config";
import { runBacktest } from "../src/lib/ashir/backtest";

async function main() {
  const [, , symbolArg, intervalArg, limitArg] = process.argv;
  const symbol = symbolArg || "BTC_USDT";
  const interval = intervalArg || "5m";
  const limit = limitArg ? parseInt(limitArg, 10) : 1000;

  console.log(`در حال دریافت ${limit} کندل ${interval} برای ${symbol} از XT...`);
  const client = new XTClient(ashirConfig.XT_API_KEY);
  const klines = await client.getKlines(symbol, interval, limit);

  if (!klines || klines.close.length < 80) {
    console.error("داده‌ی تاریخی کافی دریافت نشد. نماد/تایم‌فریم را بررسی کنید.");
    process.exit(1);
  }

  const result = runBacktest(symbol.toUpperCase(), klines);

  console.log("\n================ نتایج بک‌تست TrendPulse ================");
  console.log(`نماد: ${result.symbol}`);
  console.log(`تعداد کندل تحلیل‌شده: ${result.totalCandles}`);
  console.log(`تعداد معاملات شبیه‌سازی‌شده: ${result.trades.length}`);
  console.log(`برد/باخت: ${result.wins} / ${result.losses}`);
  console.log(`نرخ برد: ${result.winRate.toFixed(1)}٪`);
  console.log(`فاکتور سود (Profit Factor): ${result.profitFactorLabel}`);
  console.log(`میانگین R-Multiple هر معامله: ${result.avgRMultiple.toFixed(2)}R`);
  console.log(`بازده کل فرضی: ${result.totalReturnPct.toFixed(2)}٪`);
  console.log(`حداکثر افت سرمایه (Max Drawdown): ${result.maxDrawdownPct.toFixed(2)}٪`);
  console.log(`سرمایه‌ی نهایی فرضی (شروع از $1000): $${result.finalEquity.toFixed(2)}`);

  if (result.warnings.length > 0) {
    console.log("\n⚠️ هشدارها:");
    result.warnings.forEach(w => console.log(`  - ${w}`));
  }

  console.log("\nتوجه: این نتایج صرفاً برای ارزیابی منطق استراتژی روی داده‌ی گذشته است و");
  console.log("تضمینی برای عملکرد آینده نیست. اردربوک لحظه‌ای و اسلیپیج واقعی صرافی در این");
  console.log("شبیه‌سازی لحاظ نشده‌اند.\n");
}

main().catch((e) => {
  console.error("خطا در اجرای بک‌تست:", e);
  process.exit(1);
});
