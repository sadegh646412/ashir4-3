/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Klines, OrderBook } from "./types";

/**
 * TrendPulse Strategy
 * ===================
 * جایگزین کامل تمام استراتژی‌های قبلی (VolRegime / Liquidity / Funding /
 * Correlation / TimeSniper / AdvancedConfluenceScalper / MicroScalp).
 *
 * فلسفه‌ی طراحی (چرا این روش جایگزین شد):
 * سیستم قبلی ۷ استراتژی مستقل را با وزن‌های دستی و بدون بک‌تست جمع می‌زد؛
 * این یعنی یک عامل ضعیف می‌توانست به‌راحتی یک سیگنال قوی را خنثی کند و در
 * نهایت تصمیم واقعی را فقط یکی از این استراتژی‌ها (AdvancedConfluenceScalper)
 * می‌گرفت—بقیه فقط تزئینی بودند. این نسخه از یک مدل «دروازه‌ای» دومرحله‌ای
 * استفاده می‌کند که در معاملات نظام‌مند رایج و قابل بک‌تست است:
 *
 *   مرحله ۱ — تشخیص روند (Higher-Timeframe Trend):
 *     کندل‌های ۵ دقیقه در گروه‌های ۱۲تایی تجمیع می‌شوند تا یک تایم‌فریم
 *     ۱ ساعته مصنوعی ساخته شود. با EMA9/EMA21 روی این تایم‌فریم بالاتر،
 *     جهت غالب بازار تشخیص داده می‌شود. معامله فقط هم‌جهت روند غالب انجام
 *     می‌شود (نه خلاف روند)—یکی از پایه‌ای‌ترین اصول ترندفالویینگ.
 *
 *   مرحله ۲ — زمان‌بندی دقیق ورود (Low-Timeframe Entry Timing):
 *     به‌جای تعقیب کندل شکست (که اغلب باعث ورود دیرهنگام و گیر افتادن در
 *     سقف/کف موقت می‌شود)، منتظر یک برگشت کوتاه به EMA9 روی ۵ دقیقه و
 *     "پس‌گیری" مجدد قیمت در جهت روند می‌مانیم. این کار نقطه‌ی ورود را به
 *     میانگین هزینه‌ی بهتر و ریسک کمتر نزدیک می‌کند.
 *
 * فیلترهای پیش‌نیاز (Gate — الزامی، نه امتیازی):
 *   - RSI(14) باید در محدوده‌ی سالم باشد (نه اشباع خرید/فروش شدید)
 *   - نوسان نسبی (ATR/Price) نباید بیش‌ازحد پایین (بازار مرده) یا
 *     بیش‌ازحد بالا (غیرقابل پیش‌بینی) باشد
 *   - رژیم نوسان GARCH نباید "extreme" باشد (مدیریت ریسک، نه شکار سود)
 *   - حجم کندل سیگنال نباید غیرعادی پایین باشد (کندل بی‌رمق)
 *
 * فقط وقتی هر ۴ شرط بالا برقرار باشند سیگنال صادر می‌شود. امتیاز نهایی
 * (score/confidence) صرفاً برای تعیین شدت اطمینان و اندازه‌ی پوزیشن/اهرم
 * استفاده می‌شود، نه برای دور زدن دروازه‌ی ورود.
 *
 * هشدار مهم: هیچ استراتژی معاملاتی سود را تضمین نمی‌کند. این نسخه صرفاً
 * منطقی‌تر، شفاف‌تر و قابل بک‌تست است؛ نه یک "ماشین پول‌ساز".
 */

export interface TrendPulseContext {
  /** عدم تعادل اردربوک، بازه‌ی [-1..1]، پیش‌فرض ۰ (خنثی) */
  imbalance?: number;
  /** رژیم نوسان GARCH: low | normal | high | extreme | unknown */
  regime?: string;
  /** واگرایی RSI/قیمت به‌عنوان تاییدیه‌ی جانبی، بازه‌ی [-1..1]، پیش‌فرض ۰ */
  divergenceScore?: number;
  /** شناسایی سفارش نهنگ/آیسبرگ به‌عنوان تاییدیه‌ی جانبی، بازه‌ی [-1..1]، پیش‌فرض ۰ */
  icebergScore?: number;
}

export interface TrendPulseResult {
  action: "buy" | "sell" | "stay_out";
  /** امتیاز/اطمینان در بازه‌ی [0.5 , 0.95] برای هر دو جهت buy/sell (نه یک عدد قطبی) */
  score: number;
  reason: string;
  details: {
    trend: "up" | "down" | "flat";
    trendGapPct: number;
    rsi: number;
    relativeATR: number;
    volumeRatio: number;
    stopLossPct: number;
    takeProfit1Pct: number;
    takeProfit2Pct: number;
    pullbackConfirmed: boolean;
  };
}

function ema(values: number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let cur = values[0];
  out.push(cur);
  for (let i = 1; i < values.length; i++) {
    cur = (values[i] - cur) * k + cur;
    out.push(cur);
  }
  return out;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return gains === 0 ? 50 : 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  const len = closes.length;
  if (len < period + 1) return 0;
  let trSum = 0;
  for (let i = len - period; i < len; i++) {
    trSum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
  }
  return trSum / period;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** تجمیع کندل‌های ۵ دقیقه در گروه‌های `factor`تایی برای ساخت تایم‌فریم بالاتر */
function aggregate(klines: Klines, factor: number): Klines {
  if (factor <= 1) return klines;
  const open: number[] = [], high: number[] = [], low: number[] = [], close: number[] = [], volume: number[] = [];
  const n = klines.close.length;
  for (let i = 0; i + factor <= n; i += factor) {
    open.push(klines.open[i]);
    high.push(Math.max(...klines.high.slice(i, i + factor)));
    low.push(Math.min(...klines.low.slice(i, i + factor)));
    close.push(klines.close[i + factor - 1]);
    volume.push(klines.volume.slice(i, i + factor).reduce((s, v) => s + v, 0));
  }
  return { open, high, low, close, volume };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function evaluateTrendPulse(klines: Klines, ctx: TrendPulseContext = {}): TrendPulseResult {
  const imbalance = ctx.imbalance ?? 0;
  const regime = ctx.regime ?? "normal";
  const divergenceScore = ctx.divergenceScore ?? 0;
  const icebergScore = ctx.icebergScore ?? 0;

  const closes = klines.close;
  const highs = klines.high;
  const lows = klines.low;
  const opens = klines.open;
  const volumes = klines.volume;
  const len = closes.length;

  const emptyDetails = {
    trend: "flat" as const,
    trendGapPct: 0,
    rsi: 50,
    relativeATR: 0,
    volumeRatio: 1,
    stopLossPct: 0.015,
    takeProfit1Pct: 0.0225,
    takeProfit2Pct: 0.039,
    pullbackConfirmed: false,
  };

  if (len < 60) {
    return { action: "stay_out", score: 0.5, reason: "داده‌ی کافی برای تحلیل روند وجود ندارد (حداقل ۶۰ کندل لازم است).", details: emptyDetails };
  }

  // ---------- مرحله ۱: تشخیص روند در تایم‌فریم بالاتر (۱ ساعته مصنوعی) ----------
  const AGG_FACTOR = 12; // 12 x 5m = 1h
  let agg = aggregate(klines, AGG_FACTOR);
  if (agg.close.length < 25) agg = klines; // در صورت کمبود داده، تنزل نرم به همان تایم‌فریم ۵ دقیقه

  const emaFastAgg = ema(agg.close, 9);
  const emaSlowAgg = ema(agg.close, 21);
  const aLen = agg.close.length;
  const fastNow = emaFastAgg[aLen - 1];
  const slowNow = emaSlowAgg[aLen - 1];
  const slowPrevIdx = Math.max(0, aLen - 4);
  const slowPrev = emaSlowAgg[slowPrevIdx];

  const trendGapPct = slowNow > 0 ? (fastNow - slowNow) / slowNow : 0;
  const slopePositive = slowNow > slowPrev;
  const slopeNegative = slowNow < slowPrev;

  let trend: "up" | "down" | "flat" = "flat";
  if (fastNow > slowNow && slopePositive && trendGapPct > 0.0015) trend = "up";
  else if (fastNow < slowNow && slopeNegative && trendGapPct < -0.0015) trend = "down";

  // ---------- مرحله ۲: زمان‌بندی دقیق ورود روی تایم‌فریم پایین (۵ دقیقه) ----------
  const emaFast5 = ema(closes, 9);
  const emaSlow5 = ema(closes, 21);
  const rsiVal = rsi(closes, 14);
  const atrVal = atr(highs, lows, closes, 14);
  const currentPrice = closes[len - 1];
  const relativeATR = currentPrice > 0 ? atrVal / currentPrice : 0;
  const avgVol20 = mean(volumes.slice(-20));
  const volumeRatio = avgVol20 > 0 ? volumes[len - 1] / avgVol20 : 1;

  const lookback = 4;
  let touchedFromAbove = false;
  let touchedFromBelow = false;
  for (let i = len - 1 - lookback; i < len - 1; i++) {
    if (i < 0) continue;
    if (lows[i] <= emaFast5[i] * 1.0015) touchedFromAbove = true;
    if (highs[i] >= emaFast5[i] * 0.9985) touchedFromBelow = true;
  }
  const bullishReclaim = touchedFromAbove && closes[len - 1] > emaFast5[len - 1] && closes[len - 1] > opens[len - 1];
  const bearishReclaim = touchedFromBelow && closes[len - 1] < emaFast5[len - 1] && closes[len - 1] < opens[len - 1];

  // ---------- دروازه‌های الزامی (Gate) ----------
  const volOk = relativeATR > 0.0012 && relativeATR < 0.05;
  const regimeOk = regime !== "extreme";
  const volumeOk = volumeRatio >= 0.7;

  let action: "buy" | "sell" | "stay_out" = "stay_out";
  let reason = "";
  let pullbackConfirmed = false;

  if (!regimeOk) {
    reason = "رژیم نوسان بازار فوق‌العاده بی‌ثبات (extreme) است — طبق اصول مدیریت ریسک، از ورود صرف‌نظر می‌شود.";
  } else if (!volOk) {
    reason = relativeATR <= 0.0012
      ? "نوسان لحظه‌ای بازار بسیار پایین است (بازار خواب/بدون نقدینگی کافی)."
      : "نوسان لحظه‌ای بازار غیرعادی بالاست — ریسک اسلیپیج و نقض حد ضرر بیش‌ازحد است.";
  } else if (!volumeOk) {
    reason = "حجم کندل فعلی نسبت به میانگین اخیر پایین است (کندل بی‌رمق، تاییدیه‌ی کافی وجود ندارد).";
  } else if (trend === "up" && bullishReclaim && rsiVal > 38 && rsiVal < 68 && emaFast5[len - 1] > emaSlow5[len - 1]) {
    action = "buy";
    pullbackConfirmed = true;
    reason = `روند ساعتی صعودی + بازگشت قیمت از EMA9 (۵ دقیقه) و تثبیت بالای آن + RSI(14)=${rsiVal.toFixed(1)} در محدوده‌ی سالم.`;
  } else if (trend === "down" && bearishReclaim && rsiVal < 62 && rsiVal > 32 && emaFast5[len - 1] < emaSlow5[len - 1]) {
    action = "sell";
    pullbackConfirmed = true;
    reason = `روند ساعتی نزولی + بازگشت قیمت از EMA9 (۵ دقیقه) و تثبیت زیر آن + RSI(14)=${rsiVal.toFixed(1)} در محدوده‌ی سالم.`;
  } else if (trend === "flat") {
    reason = "روند مشخصی در تایم‌فریم بالاتر (۱ ساعته) شناسایی نشد — بازار رنج است و طبق استراتژی ترندفالویینگ وارد نمی‌شویم.";
  } else {
    reason = `روند ${trend === "up" ? "صعودی" : "نزولی"} شناسایی شد اما هنوز الگوی بازگشت‌و‌تثبیت روی EMA9 (۵ دقیقه) یا شرط RSI تایید نشده — منتظر نقطه‌ی ورود دقیق‌تر می‌مانیم.`;
  }

  const details = {
    trend,
    trendGapPct,
    rsi: rsiVal,
    relativeATR,
    volumeRatio,
    stopLossPct: 0.015,
    takeProfit1Pct: 0.0225,
    takeProfit2Pct: 0.039,
    pullbackConfirmed,
  };

  if (action === "stay_out") {
    // امتیاز خنثی با کمی گرایش جهت‌دار صرفاً برای گزارش‌دهی/لاگ "نزدیک به سیگنال"
    // استفاده می‌شود؛ در تصمیم‌گیری معاملاتی هیچ نقشی ندارد چون action همچنان stay_out است.
    const leanScore = trend === "up" ? 0.56 : trend === "down" ? 0.44 : 0.5;
    return { action, score: leanScore, reason, details };
  }

  // ---------- محاسبه‌ی امتیاز/اطمینان (فقط برای سایز پوزیشن و اهرم، نه دروازه‌ی ورود) ----------
  const trendStrengthScore = clamp(Math.abs(trendGapPct) / 0.01, 0, 1);
  const rsiHealthScore = clamp(1 - Math.abs(rsiVal - 50) / 25, 0, 1);
  const volumeScore = clamp((volumeRatio - 0.7) / 1.3, 0, 1);
  const orderflowAlign = action === "buy" ? clamp(imbalance, 0, 1) : clamp(-imbalance, 0, 1);
  const divergenceAlign = action === "buy" ? clamp(divergenceScore, 0, 1) : clamp(-divergenceScore, 0, 1);
  const icebergAlign = action === "buy" ? clamp(icebergScore, 0, 1) : clamp(-icebergScore, 0, 1);

  let score = 0.55
    + 0.15 * trendStrengthScore
    + 0.10 * rsiHealthScore
    + 0.08 * volumeScore
    + 0.06 * orderflowAlign
    + 0.03 * divergenceAlign
    + 0.03 * icebergAlign;
  score = clamp(score, 0.55, 0.95);

  // ---------- مدیریت ریسک بر پایه‌ی ATR (قطعی و شفاف، بدون نویز مصنوعی) ----------
  const slMultiplier = 1.3;
  const stopLossPct = clamp(slMultiplier * relativeATR, 0.008, 0.03);
  const RR1 = 1.5;
  const RR2 = 2.6;
  details.stopLossPct = stopLossPct;
  details.takeProfit1Pct = stopLossPct * RR1;
  details.takeProfit2Pct = stopLossPct * RR2;

  return { action, score, reason, details };
}

export class TrendPulseStrategy {
  analyze(klines: Klines, orderbook: OrderBook | null, ctx: TrendPulseContext = {}): TrendPulseResult {
    return evaluateTrendPulse(klines, ctx);
  }
}
