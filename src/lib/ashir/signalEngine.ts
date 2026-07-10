/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GARCH11, VolumeAnalyzer, OrderFlowAnalyzer } from "./indicators";
import { evaluateTrendPulse } from "./strategies";
import { ShadowHunter, PainPointDetector, DivergenceSniffer } from "./advancedStrategies";
import { Klines, OrderBook, Signal } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * جایگزین ساده و شفاف MLOptimizer قبلی.
 * سیستم قبلی یک "delta rule" شبه‌یادگیری داشت که مستقل از جهت معامله (خرید/فروش)
 * وزن‌ها را آپدیت می‌کرد و عملاً روی امتیازهای ساختگی (0.85/0.45) کار می‌کرد —
 * یعنی چیزی که به‌جای بهبود سیگنال، فقط اطمینان کاذب تولید می‌کرد. این نسخه هیچ
 * ادعای «یادگیری هوشمند» ندارد و فقط آمار واقعی برد/باخت را برای نمایش نگه می‌دارد.
 */
class PerformanceTracker {
  private wins = 0;
  private losses = 0;

  recordTrade(_subSignals: unknown, _action: string, result: string) {
    if (result === "win") this.wins++;
    else this.losses++;
  }

  getWeights(): Record<string, number> {
    const total = this.wins + this.losses;
    if (total === 0) return {};
    return {
      historical_win_rate: Math.round((this.wins / total) * 1000) / 1000,
      sample_size: total,
    };
  }
}

export class SignalEngine {
  private garch = new GARCH11();
  private orderflow = new OrderFlowAnalyzer();
  private shadowHunter = new ShadowHunter();
  private painDetector = new PainPointDetector();
  private divergenceSniffer = new DivergenceSniffer();
  private perf = new PerformanceTracker();

  public sensitivity: "conservative" | "balanced" | "active" = "conservative";
  // نگه‌داشته‌شده برای سازگاری با پنل/سرور قدیمی؛ در استراتژی جدید دیگر لایه‌ی
  // جداگانه‌ای برای غیرفعال‌سازی وجود ندارد — فقط حدنصاب حساسیت دستی را دور می‌زند.
  public disable9Layers = false;
  public strategy: string = "auto";
  public minScore = 0.60;

  // 🧠 Smart Risk-Reduction: اعتماد اضافه‌ای که موتور باید پس از یک زیان اخیر
  // روی این نماد کسب کند (به‌مرور زمان صفر می‌شود، جایگزین قرنطینه‌ی سخت قدیمی)
  public extraMinConfidence = 0;

  private getRequiredScore(): number {
    const base = this.sensitivity === "conservative" ? 0.66 : this.sensitivity === "active" ? 0.56 : 0.60;
    return Math.min(0.92, base + this.extraMinConfidence);
  }

  async analyze(symbol: string, klines: Klines, orderbook: OrderBook | null, change24h = 0, btcChange = 0, livePrice = 0): Promise<Signal | null> {
    const closes = klines.close;
    const highs = klines.high;
    const lows = klines.low;
    const volumes = klines.volume;

    // حداقل تاریخچه‌ی لازم برای استراتژی TrendPulse (تجمیع ۱ ساعته + اندیکاتورهای ۵ دقیقه)
    if (closes.length < 60) return null;

    const currentPrice = livePrice > 0 ? livePrice : closes[closes.length - 1];

    // ==========================================
    // 📊 زمینه‌ی بازار (اطلاعاتی — نه گیت تصمیم‌گیری)
    // ==========================================
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    this.garch.fit(returns);
    const volMetrics = this.garch.getMetrics();
    const volSurgeResult = VolumeAnalyzer.detectVolumeSurge(volumes);
    const trailingVolumeMA = volumes.slice(-24).reduce((s, v) => s + v, 0) / 24;
    const volumeSurgeRatio = trailingVolumeMA > 0 ? volumes[volumes.length - 1] / trailingVolumeMA : 1.0;

    let orderflowScore = 0.5;
    let orderflowSignal = "neutral";
    let imbalance = 0;
    if (orderbook) {
      const ofResult = this.orderflow.analyze(orderbook.bids, orderbook.asks, currentPrice);
      orderflowScore = ofResult.score;
      orderflowSignal = ofResult.signal;
      imbalance = ofResult.imbalance;
    }

    let icebergResult = { iceberg_detected: false, direction: "none", strength: 0, message: "" };
    if (orderbook) {
      icebergResult = this.shadowHunter.detectIceberg(orderbook.bids, orderbook.asks);
    }
    const icebergCtxScore = icebergResult.direction === "accumulation" ? icebergResult.strength
      : icebergResult.direction === "distribution" ? -icebergResult.strength : 0;

    const yesterdayHigh = highs[highs.length - 2];
    const yesterdayLow = lows[lows.length - 2];
    const weeklyOpen = klines.open.length >= 7 ? klines.open[klines.open.length - 7] : klines.open[0];
    const painResult = this.painDetector.detect(
      currentPrice,
      yesterdayHigh,
      yesterdayLow,
      weeklyOpen,
      orderbook?.bids || [],
      orderbook?.asks || []
    );

    const divergenceResult = this.divergenceSniffer.sniff(closes, volumes);
    const divergenceCtxScore = divergenceResult.type === "bullish" ? divergenceResult.strength
      : divergenceResult.type === "bearish" ? -divergenceResult.strength : 0;

    // ==========================================
    // 🎯 تصمیم‌گیری اصلی: استراتژی واحد TrendPulse (روند + زمان‌بندی دقیق ورود)
    // ==========================================
    const strat = evaluateTrendPulse(klines, {
      imbalance: (orderflowScore - 0.5) * 2, // نگاشت از [0..1] به [-1..1]
      regime: volMetrics.regime,
      divergenceScore: divergenceCtxScore,
      icebergScore: icebergCtxScore,
    });

    let action = strat.action;
    let finalScore = strat.score;
    let vetoReason = strat.reason;

    const requiredScore = this.getRequiredScore();

    // حدنصاب حساسیت کاربر (conservative/balanced/active) — فقط زمانی اعمال می‌شود که
    // کاربر به‌صورت دستی آن را دور نزده باشد. توجه: این حدنصاب هرگز دروازه‌ی خود
    // استراتژی (روند + الگوی بازگشت + RSI سالم + نوسان منطقی) را دور نمی‌زند، فقط
    // سیگنال‌های تایید شده‌ی ضعیف‌تر از سطح دلخواه کاربر را فیلتر می‌کند.
    if (!this.disable9Layers && action !== "stay_out" && finalScore < requiredScore) {
      const extraNote = this.extraMinConfidence > 0
        ? ` (شامل +${(this.extraMinConfidence * 100).toFixed(1)}٪ افزایش موقت حدنصاب به دلیل کاهش ریسک هوشمند پس از زیان اخیر)`
        : "";
      vetoReason = `سطح اطمینان سیگنال (${(finalScore * 100).toFixed(1)}٪) کمتر از حدنصاب حساسیت انتخابی شما (${(requiredScore * 100).toFixed(1)}٪) است${extraNote}. ورود انجام نشد.`;
      action = "stay_out";
    }

    const dynamicThreshold = requiredScore;

    // ==========================================
    // 🛡️ مدیریت ریسک: حد ضرر/سود بر پایه‌ی ATR (از خود استراتژی، بدون نویز مصنوعی)
    // ==========================================
    let stopLoss = currentPrice;
    let takeProfit = currentPrice;
    let takeProfit2 = currentPrice;

    if (action === "buy") {
      stopLoss = currentPrice * (1 - strat.details.stopLossPct);
      takeProfit = currentPrice * (1 + strat.details.takeProfit1Pct);
      takeProfit2 = currentPrice * (1 + strat.details.takeProfit2Pct);
    } else if (action === "sell") {
      stopLoss = currentPrice * (1 + strat.details.stopLossPct);
      takeProfit = currentPrice * (1 - strat.details.takeProfit1Pct);
      takeProfit2 = currentPrice * (1 - strat.details.takeProfit2Pct);
    }

    const confidence = action !== "stay_out" ? clamp(finalScore, 0.5, 0.95) : 0.5;

    // ==========================================
    // ⚡ انتخاب اهرم هوشمند (۱۰x تا ۵۰x) با محافظ نقض/لیکوئید شدن
    // ==========================================
    // نکته‌ی مهم مدیریت ریسک: اهرم بالا به‌خودی‌خود باعث افزایش درصد ضرر سرمایه در
    // برخورد به حد ضرر نمی‌شود (چون حجم پوزیشن مستقل محاسبه می‌شود)، اما اهرم بالا
    // فاصله‌ی لیکوئید شدن را کم می‌کند. اگر لغزش قیمت (اسلیپیج) یا تاخیر اجرای
    // سفارش باعث شود قیمت قبل از فعال شدن حد ضرر به نقطه‌ی لیکوئیدی برسد، کل
    // مارجین آن پوزیشن از دست می‌رود. به همین دلیل اینجا یک "محافظ ایمنی" اضافه
    // شده: حاصلضرب اهرم × درصد حد ضرر هرگز نباید از ۵۰٪ فاصله تا لیکوئید شدن
    // بیشتر شود.
    let leverageSelection = 10;
    if (action !== "stay_out") {
      const confidenceSpan = Math.max(0.0001, 0.95 - requiredScore);
      const normalizedConfidence = clamp((finalScore - requiredScore) / confidenceSpan, 0, 1);
      const volRiskDampener = clamp(0.012 / Math.max(strat.details.relativeATR, 0.0001), 0.3, 1.0);
      let rawLeverage = (10 + normalizedConfidence * 40) * volRiskDampener;

      const LIQUIDATION_SAFETY_FRACTION = 0.5; // حداکثر ۵۰٪ فاصله تا مارجین‌کال مصرف شود
      const maxLeverageForSafety = LIQUIDATION_SAFETY_FRACTION / Math.max(strat.details.stopLossPct, 0.001);

      rawLeverage = Math.min(rawLeverage, maxLeverageForSafety);
      leverageSelection = Math.round(clamp(rawLeverage, 10, 50));
    }

    // ==========================================
    // 📦 sub_signals: فقط اطلاعات واقعی (نه فیلترهای ساختگی قدیمی)
    // ==========================================
    const trendFa = strat.details.trend === "up" ? "صعودی" : strat.details.trend === "down" ? "نزولی" : "رنج/بدون روند مشخص";
    const subSignalsObj = {
      trend: {
        score: strat.details.trend === "up" ? 0.8 : strat.details.trend === "down" ? 0.2 : 0.5,
        signal: strat.details.trend === "up" ? "buy" : strat.details.trend === "down" ? "sell" : "neutral",
        reason: `روند تایم‌فریم بالاتر (۱ساعته مصنوعی): ${trendFa} (فاصله EMA9/EMA21: ${(strat.details.trendGapPct * 100).toFixed(2)}٪)`,
      },
      orderflow: {
        score: orderflowScore,
        signal: orderflowSignal,
        reason: `عدم تعادل اردربوک: ${(imbalance * 100).toFixed(1)}٪`,
      },
      iceberg: {
        score: icebergResult.direction === "accumulation" ? 0.8 : icebergResult.direction === "distribution" ? 0.2 : 0.5,
        message: icebergResult.message,
      },
      pain_point: {
        score: painResult.active ? (currentPrice > painResult.target_price ? 0.2 : 0.8) : 0.5,
        message: painResult.active ? painResult.reason : "",
      },
      divergence: {
        score: divergenceResult.type === "bullish" ? 0.8 : divergenceResult.type === "bearish" ? 0.2 : 0.5,
        message: divergenceResult.message,
      },
    };

    return {
      symbol,
      action,
      score: finalScore,
      confidence,
      price: currentPrice,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      take_profit_2: takeProfit2,
      leverage: leverageSelection,
      daily_vol: volMetrics.daily_vol,
      regime: volMetrics.regime,
      vol_surge: volSurgeResult.surge || volumeSurgeRatio >= 1.4,
      vol_surge_msg: volSurgeResult.message || `افزایش نسبی حجم معاملات (×${volumeSurgeRatio.toFixed(1)})`,
      imbalance,
      iceberg: icebergResult,
      pain_point: painResult,
      divergence: divergenceResult,
      dynamic_threshold: dynamicThreshold,
      ml_weights: this.perf.getWeights(),
      sub_signals: subSignalsObj,
      veto_reason: vetoReason !== "" ? vetoReason : undefined,
    };
  }

  recordTrade(subSignals: any, action: string, result: string) {
    this.perf.recordTrade(subSignals, action, result);
  }
}
