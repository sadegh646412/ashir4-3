/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Klines } from "./types";
import { evaluateTrendPulse } from "./strategies";

/**
 * ماژول بک‌تست TrendPulse
 * =======================
 * قبل از اجرای زنده روی سرمایه‌ی واقعی، این ماژول استراتژی را روی داده‌ی
 * تاریخی (کندل‌های واقعی گذشته) شبیه‌سازی می‌کند تا آمار واقع‌بینانه‌ای از
 * نرخ برد، فاکتور سود و حداکثر افت سرمایه به‌دست بیاید.
 *
 * محدودیت‌های صادقانه (مهم برای تفسیر درست نتایج):
 *  - این بک‌تست فقط از داده‌ی کندل استفاده می‌کند؛ اردربوک لحظه‌ای، شکار
 *    آیسبرگ و واگرایی حجمی تاریخی در دسترس نیست، پس این بخش‌ها با مقدار
 *    خنثی (۰) در نظر گرفته می‌شوند — یعنی نتیجه‌ی بک‌تست معمولاً کمی
 *    محافظه‌کارانه‌تر از رفتار زنده‌ی واقعی است، نه خوش‌بینانه‌تر.
 *  - ورود همیشه در قیمت بازِ کندل بعد از سیگنال شبیه‌سازی می‌شود (نه کلوز
 *    همان کندل) تا از nگاه‌به‌جلو (lookahead bias) جلوگیری شود.
 *  - اگر در یک کندل واحد هم حد ضرر و هم حد سود قابل لمس باشند، به‌صورت
 *    محافظه‌کارانه فرض می‌شود حد ضرر زودتر خورده (worst-case)، مگر این‌که
 *    از داده‌ی درون‌کندلی دقیق‌تری در دسترس باشیم که اینجا نیست.
 *  - این ابزار فقط یک نماد را در هر بار پردازش می‌کند و همزمانی چند
 *    پوزیشن باز روی نمادهای مختلف (correlation risk) را شبیه‌سازی نمی‌کند.
 *  - نتیجه‌ی بک‌تست هرگز تضمین‌کننده‌ی عملکرد آینده نیست.
 */

export interface BacktestTrade {
  entryIndex: number;
  exitIndex: number;
  action: "buy" | "sell";
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit1: number;
  exitReason: "take_profit" | "stop_loss" | "end_of_data";
  pnlPct: number; // درصد سود/زیان روی مارجین با اهرم اعمال‌شده
  rMultiple: number; // سود/زیان به نسبت ریسک اولیه (۱R = فاصله‌ی حد ضرر)
  leverage: number;
}

export interface BacktestResult {
  symbol: string;
  totalCandles: number;
  trades: BacktestTrade[];
  wins: number;
  losses: number;
  winRate: number; // 0-100
  profitFactor: number | null;
  profitFactorLabel: string;
  avgRMultiple: number;
  totalReturnPct: number; // رشد سرمایه‌ی فرضی از ابتدا تا انتها (٪)
  maxDrawdownPct: number;
  finalEquity: number;
  equityCurve: { index: number; equity: number }[];
  warnings: string[];
}

export interface BacktestOptions {
  initialCapital?: number;
  /** درصد ثابتی از سرمایه که در صورت خوردن حد ضرر از دست می‌رود (مدیریت ریسک استاندارد) */
  riskPerTradePct?: number;
  /** سقف اهرم قابل استفاده (باید هم‌راستا با تنظیمات signalEngine باشد، پیش‌فرض ۵۰) */
  maxLeverage?: number;
  /** حداقل تعداد کندل قبل از شروع شبیه‌سازی (باید با حداقل مورد نیاز استراتژی هم‌خوان باشد) */
  warmupCandles?: number;
}

export function runBacktest(symbol: string, klines: Klines, options: BacktestOptions = {}): BacktestResult {
  const initialCapital = options.initialCapital ?? 1000;
  const riskPerTradePct = options.riskPerTradePct ?? 0.01; // ریسک ۱٪ سرمایه در هر معامله
  const maxLeverage = options.maxLeverage ?? 50;
  const warmupCandles = options.warmupCandles ?? 60;

  const warnings: string[] = [];
  const n = klines.close.length;
  const trades: BacktestTrade[] = [];

  let equity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;
  const equityCurve: { index: number; equity: number }[] = [{ index: warmupCandles, equity }];

  if (n < warmupCandles + 20) {
    warnings.push(`داده‌ی کافی برای بک‌تست معنادار وجود ندارد (حداقل ${warmupCandles + 20} کندل لازم است، ${n} کندل موجود است).`);
    return {
      symbol, totalCandles: n, trades: [], wins: 0, losses: 0, winRate: 0,
      profitFactor: null, profitFactorLabel: "0.00", avgRMultiple: 0,
      totalReturnPct: 0, maxDrawdownPct: 0, finalEquity: equity, equityCurve, warnings,
    };
  }

  let i = warmupCandles;
  while (i < n - 1) {
    const windowKlines: Klines = {
      open: klines.open.slice(0, i + 1),
      high: klines.high.slice(0, i + 1),
      low: klines.low.slice(0, i + 1),
      close: klines.close.slice(0, i + 1),
      volume: klines.volume.slice(0, i + 1),
    };

    // در بک‌تست، اردربوک/واگرایی/آیسبرگ لحظه‌ای در دسترس نیست — خنثی (۰) در نظر گرفته می‌شود.
    const strat = evaluateTrendPulse(windowKlines, { imbalance: 0, regime: "normal", divergenceScore: 0, icebergScore: 0 });

    if (strat.action === "stay_out") {
      i++;
      continue;
    }

    // اجرای ورود در قیمت باز شدن کندل بعدی (جلوگیری از lookahead bias)
    const entryIndex = i + 1;
    const entryPrice = klines.open[entryIndex];
    const stopLossPct = strat.details.stopLossPct;
    const tp1Pct = strat.details.takeProfit1Pct;

    const stopLoss = strat.action === "buy" ? entryPrice * (1 - stopLossPct) : entryPrice * (1 + stopLossPct);
    const takeProfit1 = strat.action === "buy" ? entryPrice * (1 + tp1Pct) : entryPrice * (1 - tp1Pct);

    // اهرم: همان قاعده‌ی محافظ لیکوئید شدن signalEngine (حداکثر ۵۰٪ فاصله تا مارجین‌کال مصرف شود)
    const confidenceLeverage = 10 + Math.max(0, Math.min(1, (strat.score - 0.55) / 0.4)) * 40;
    const safetyCap = 0.5 / Math.max(stopLossPct, 0.001);
    const leverage = Math.max(10, Math.min(maxLeverage, Math.min(confidenceLeverage, safetyCap)));

    let exitIndex = entryIndex;
    let exitPrice = entryPrice;
    let exitReason: BacktestTrade["exitReason"] = "end_of_data";

    for (let j = entryIndex + 1; j < n; j++) {
      const hi = klines.high[j];
      const lo = klines.low[j];
      const hitStop = strat.action === "buy" ? lo <= stopLoss : hi >= stopLoss;
      const hitTp = strat.action === "buy" ? hi >= takeProfit1 : lo <= takeProfit1;

      if (hitStop) {
        exitIndex = j; exitPrice = stopLoss; exitReason = "stop_loss";
        break;
      }
      if (hitTp) {
        exitIndex = j; exitPrice = takeProfit1; exitReason = "take_profit";
        break;
      }
      exitIndex = j;
    }

    const priceMovePct = strat.action === "buy"
      ? (exitPrice - entryPrice) / entryPrice
      : (entryPrice - exitPrice) / entryPrice;

    const rMultiple = stopLossPct > 0 ? priceMovePct / stopLossPct : 0;

    // مدیریت ریسک استاندارد: هر معامله دقیقاً riskPerTradePct از سرمایه‌ی فعلی را در معرض خطر
    // قرار می‌دهد (نه اندازه‌ی ثابت) — یعنی نتیجه‌ی هر معامله = rMultiple × ریسک آن معامله.
    const tradeRiskUsd = equity * riskPerTradePct;
    const pnlUsd = rMultiple * tradeRiskUsd;
    equity = Math.max(0, equity + pnlUsd);
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
    equityCurve.push({ index: exitIndex, equity });

    trades.push({
      entryIndex, exitIndex, action: strat.action, entryPrice, exitPrice,
      stopLoss, takeProfit1, exitReason,
      pnlPct: priceMovePct * leverage * 100,
      rMultiple, leverage: Math.round(leverage),
    });

    i = exitIndex + 1;
  }

  const wins = trades.filter(t => t.rMultiple > 0).length;
  const losses = trades.filter(t => t.rMultiple <= 0).length;
  const grossProfit = trades.filter(t => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter(t => t.rMultiple <= 0).reduce((s, t) => s + t.rMultiple, 0));

  let profitFactor: number | null;
  let profitFactorLabel: string;
  if (grossLoss === 0 && grossProfit > 0) { profitFactor = null; profitFactorLabel = "∞"; }
  else if (grossLoss === 0) { profitFactor = 0; profitFactorLabel = "0.00"; }
  else { profitFactor = grossProfit / grossLoss; profitFactorLabel = profitFactor.toFixed(2); }

  const avgRMultiple = trades.length > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const totalReturnPct = ((equity - initialCapital) / initialCapital) * 100;

  if (trades.length < 20) {
    warnings.push(`تعداد معاملات شبیه‌سازی‌شده کم است (${trades.length} معامله) — نتایج آماری از نظر معناداری ضعیف است و نباید به‌تنهایی مبنای تصمیم قرار گیرد.`);
  }

  return {
    symbol,
    totalCandles: n,
    trades,
    wins,
    losses,
    winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
    profitFactor,
    profitFactorLabel,
    avgRMultiple,
    totalReturnPct,
    maxDrawdownPct,
    finalEquity: equity,
    equityCurve,
    warnings,
  };
}
