/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { XTClient } from "./xtClient";
import { SignalEngine } from "./signalEngine";
import { RiskManager } from "./riskManager";
import { TelegramReporter } from "./telegramReporter";
import { CorrelationManager } from "./correlationManager";
import { AdaptiveExitEngine } from "./adaptiveExitEngine";
import { PositionGuard } from "./positionGuard";
import { Config, Signal, Position } from "./types";
import { selectTopCoins, CoinRotationReport, CoinBacktestSummary } from "./coinSelector";
import fs from "fs/promises";
import path from "path";
import ccxt from "ccxt";

export class WaterfallScanner {
  private client: XTClient;
  private reporter: TelegramReporter;
  private config: Config;
  private engine = new SignalEngine();
  public rm: RiskManager;
  private corrMgr = new CorrelationManager();
  private exitEngine!: AdaptiveExitEngine;
  private positionGuard!: PositionGuard;
  public count = 0;
  public btcChange = 0;
  public orders: Position[] = [];
  public closedOrders: Position[] = [];
  public isRunning = false;
  public shouldBeRunning = true; // Tracks user intent (true = should stay active, false = explicitly stopped)
  public lastScanTime: number | null = null;
  public nextScanTime: number | null = null;
  public currentProgress = "";
  public lastError: string | null = null;
  public scanLogs: string[] = [];
  public isStateLoaded = false;
  public welcomeSent = false;
  // 📊 Real (non-fake) performance metrics for the header tickertape:
  // measured from the actual most recent scan cycle.
  public lastScanDurationMs: number | null = null;
  public lastScanAssetCount = 0;
  public lastScanAssetsPerSec: number | null = null;
  private stateFilePath = path.join(process.cwd(), "ashir_state.json");

  // Adaptive Self-Correction & Diagnostics System
  public consecutiveLosses = 0;
  public adaptiveSensitivityOverride: "conservative" | "balanced" | "active" | null = null;
  public leverageMultiplier = 1.0;
  // 🧠 Smart Risk-Reduction Map (replaces the old hard "quarantine" block):
  // instead of fully banning a symbol/group from trading, each entry stores a
  // temporary risk-reduction factor (0..1, applied to position size & leverage)
  // and an extra confidence requirement that decays linearly back to zero by `until`.
  // The symbol stays scannable; the bot can still take an exceptionally strong
  // setup, but with reduced size and a higher bar to clear.
  public riskReductionMap: Record<string, { until: number; startedAt: number; sizeFactor: number; extraConfidence: number }> = {};
  public diagnosticLogs: { id: string; time: number; symbol: string; type: string; title: string; message: string; actionTaken: string }[] = [];

  // 🎯 چرخش هفتگی ۵ ارز برتر (Coin Rotation): وقتی فعال باشد، اسکن فقط روی
  // نمادهایی که در آخرین بک‌تست بهترین نرخ برد را داشته‌اند انجام می‌شود.
  public coinRotationEnabled = false;
  public selectedCoins: CoinBacktestSummary[] = [];
  public lastRotationAt: number | null = null;
  public lastRotationReport: CoinRotationReport | null = null;
  public rotationInProgress = false;
  public rotationIntervalDays = 7;

  // Private live exchange configuration
  public apiKey = "";
  public secretKey = "";
  public tradingMode: "simulation" | "real" = "simulation";
  public realBalance = 0;
  public ccxtExchange: any = null;
  private _sensitivity: "conservative" | "balanced" | "active" | "auto_cortex" = "auto_cortex";
  public get sensitivity() {
    return this._sensitivity;
  }
  public set sensitivity(val: "conservative" | "balanced" | "active" | "auto_cortex") {
    this._sensitivity = val;
    if (val === "auto_cortex") {
      this.engine.sensitivity = this.calculateCortexDynamicSensitivity();
    } else {
      this.engine.sensitivity = val;
    }
  }
  private _disable9Layers = false;
  public get disable9Layers() {
    return this._disable9Layers;
  }
  public set disable9Layers(val: boolean) {
    this._disable9Layers = val;
    this.engine.disable9Layers = val;
  }
  public rejectedSignals: { symbol: string; action: string; score: number; threshold: number; reason: string; time: number }[] = [];

  private _strategy: "strict_elitescalp" | "active_goldenscalp" | "auto_cortex" | "auto" = "auto_cortex";
  public get strategy() {
    return this._strategy;
  }
  public set strategy(val: "strict_elitescalp" | "active_goldenscalp" | "auto_cortex" | "auto") {
    this._strategy = val;
    if (val === "auto_cortex" || val === "auto") {
      this.engine.strategy = this.calculateCortexDynamicStrategy();
    } else {
      this.engine.strategy = val;
    }
  }

  private formatPrice(v: number): string {
    if (!v) return "0.0000";
    if (v < 0.0001) return v.toFixed(8);
    if (v < 2) return v.toFixed(5);
    if (v < 10) return v.toFixed(4);
    return v.toFixed(2);
  }

  public initCcxt() {
    if (this.apiKey && this.secretKey) {
      try {
        this.ccxtExchange = new ccxt.xt({
          apiKey: this.apiKey,
          secret: this.secretKey,
          enableRateLimit: true,
        });
        this._addLog("سامانه معاملاتی واقعی XT (CCXT) با موفقیت پیاده‌سازی و راه‌اندازی شد.");
        this.updateRealBalance().catch(err => {
          this._addLog(`بخش دریافت دارایی واقعی با خطای اولیه مواجه شد: ${err.message || err}`);
        });
      } catch (err: any) {
        this._addLog(`خطا در تنظیم کلاینت واقعی صرافی: ${err.message || err}`);
      }
    } else {
      this.ccxtExchange = null;
    }
  }

  public async updateRealBalance() {
    if (this.tradingMode === "real" && this.ccxtExchange) {
      try {
        const balance = await this.ccxtExchange.fetchBalance();
        this.realBalance = balance?.total?.USDT || balance?.free?.USDT || 0;
        this._addLog(`[حساب واقعی] همگام‌سازی مانده حساب با ثبات: ${this.realBalance.toFixed(2)} USDT`);
      } catch (e: any) {
        console.error("Failed to fetch balance from XT exchange:", e.message || e);
      }
    }
  }

  public async closeActivePosition(orderId: string, currentPrice: number, exitReason: string) {
    const order = this.orders.find(o => o.id === orderId);
    if (!order || order.status === "closed") return;

    // Remove from active list and set status immediately to prevent any concurrent race conditions
    order.status = "closed";
    this.orders = this.orders.filter(o => o.id !== orderId);
    this.exitEngine.clear(orderId);
    this.positionGuard.clear(orderId);

    let actualExitPrice = currentPrice;
    let isRealExitSuccess = true;

    if (this.tradingMode === "real" && order.action === "buy") {
      this._addLog(`🚨 [REAL MODE] Triggering REAL MARKET SELL for ${order.symbol} to exit position...`);
      try {
        if (!this.ccxtExchange) {
          throw new Error("Private exchange client not initialized.");
        }
        const ccxtSym = order.symbol.toUpperCase().replace("_", "/");
        const response = await this.ccxtExchange.createMarketSellOrder(ccxtSym, order.quantity);
        if (response && response.id) {
          actualExitPrice = response.average || response.price || currentPrice;
          this._addLog(`✅ XT Real Market Sell filled! Order ID: ${response.id}. Exit Price: ${actualExitPrice}`);
        }
      } catch (err: any) {
        isRealExitSuccess = false;
        order.status = "filled"; // Revert status

        // Re-insert order back into active orders list since exit failed
        if (!this.orders.some(o => o.id === orderId)) {
          this.orders.push(order);
        }

        const msg = `❌ [REAL EXIT FAILED] Failed to exit live order for ${order.symbol}: ${err.message || err}`;
        this._addLog(msg);
        await this.reporter.send(`🚨🚨 <b>توجه! خطا در فروش/بستن پوزیشن واقعی!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nعلت بستن: <code>${exitReason}</code>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ <b>لطفاً پوزیشن فوق را به صورت دستی در پنل صرافی ببندید!</b>`);
        throw err;
      }
    }

    if (isRealExitSuccess) {
      order.exit_price = actualExitPrice;
      order.closed_at = Date.now();

      // Improve exit reason messaging when exit happens at Breakeven/Risk-Free entry price after a successful TP1 hit
      let adjustedReason = exitReason;
      if (order.tp1_hit && exitReason === "Stop Loss (حد ضرر)") {
        adjustedReason = "حد ضرر در نقطه ورود (ریسک فری)";
      }
      order.exit_reason = adjustedReason;

      let finalPnl = 0;
      if (order.action === "buy") {
        finalPnl = ((actualExitPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
      } else {
        finalPnl = ((order.entry_price - actualExitPrice) / order.entry_price) * 100 * (order.leverage || 1);
      }

      const tp2_pnl_pct = finalPnl;
      const tp2_pnl_usd = (tp2_pnl_pct / 100) * order.position_value;

      let total_pnl_pct = 0;
      let total_pnl_usd = 0;

      if (order.tp1_hit) {
        total_pnl_usd = (order.tp1_pnl_usd || 0) + tp2_pnl_usd;
        total_pnl_pct = ((order.tp1_pnl_pct || 0) + tp2_pnl_pct) / 2;
      } else {
        total_pnl_usd = tp2_pnl_usd;
        total_pnl_pct = tp2_pnl_pct;
      }

      order.tp2_pnl_pct = tp2_pnl_pct;
      order.tp2_pnl_usd = tp2_pnl_usd;
      order.pnl_pct = total_pnl_pct;
      order.pnl_usd = total_pnl_usd;

      const isWin = total_pnl_usd >= 0;
      this.rm.totalTrades += 1;
      if (isWin) this.rm.winTrades += 1;

      try {
        this.engine.recordTrade(order.sub_signals, order.action, isWin ? "win" : "loss");
      } catch (e) {}

      if (this.tradingMode === "real") {
        await this.updateRealBalance();
        this.rm.capital = Math.max(10, this.realBalance);
      } else {
        // TP1 already added order.tp1_pnl_usd to balance when TP1 was hit.
        // We only add the remaining tp2 portion here!
        this.rm.capital = Math.max(10, this.rm.capital + tp2_pnl_usd);
      }

      this.closedOrders.unshift(order);
      if (this.closedOrders.length > 100) {
        this.closedOrders = this.closedOrders.slice(0, 100);
      }

      this._addLog(`🚨 EXIT COMPLETE: ${order.symbol} closed. PnL: ${total_pnl_pct.toFixed(2)}% ($${total_pnl_usd.toFixed(2)})`);
      
      // Execute the adaptive self-correction & diagnostics routine
      try {
        await this.autoDiagnoseAndAdapt(order, total_pnl_pct, total_pnl_usd);
      } catch (diagErr) {
        console.error("Error in diagnostics adaptation loop:", diagErr);
      }

      await this.saveState();

      let reportMsg = "";
      const exitEmoji = total_pnl_usd >= 0 ? "🟢" : "🔴";

      if (order.tp1_hit) {
        reportMsg = `
${exitEmoji} <b>گزارش تسویه نهایی معامله دو مرحله‌ای (${exitReason})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
🛡️ <b>اهرم اصلی:</b> <code>${order.leverage || 20}x</code>
💰 <b>قیمت ورود اصلی:</b> <code>$${this.formatPrice(order.entry_price)}</code>

📊 <b>مرحله اول (جزئی ۵۰٪ - تارگت ۱):</b>
  ├ 🚪 <b>قیمت خروج اول:</b> <code>$${this.formatPrice(order.tp1_exit_price || order.take_profit_1)}</code>
  ├ 🟢 <b>سود درصد اول:</b> <code>+${(order.tp1_pnl_pct || 0).toFixed(2)}%</code>
  └ 💵 <b>سود دلاری اول:</b> <code>$${(order.tp1_pnl_usd || 0).toFixed(2)}</code>

📊 <b>مرحله دوم (باقیمانده ۵۰٪ - خروج نهایی):</b>
  ├ 🚪 <b>قیمت خروج دوم:</b> <code>$${this.formatPrice(actualExitPrice)}</code>
  ├ 📝 <b>علت خروج نهایی:</b> <code>${exitReason}</code>
  ├ 📈 <b>سود درصد دوم:</b> <code>${tp2_pnl_pct >= 0 ? "+" : ""}${tp2_pnl_pct.toFixed(2)}%</code>
  └ 💵 <b>سود دلاری دوم:</b> <code>$${tp2_pnl_usd >= 0 ? "+" : ""}${tp2_pnl_usd.toFixed(2)}</code>

🏆 <b>برآیند نهایی کل معامله (تجمیع شده):</b>
  ├ 💹 <b>تجمیع سود کل (میانگین دو پله):</b> <b><code>${total_pnl_pct >= 0 ? "+" : ""}${total_pnl_pct.toFixed(2)}%</code></b>
  ├ 💵 <b>برآیند سود دلاری کل:</b> <b><code>${total_pnl_usd >= 0 ? "+" : ""}$${total_pnl_usd.toFixed(2)}</code></b>
  └ 💰 <b>کل دارایی پس از تسویه:</b> <code>$${this.rm.capital.toFixed(2)}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
        `.trim();
      } else {
        reportMsg = `
${exitEmoji} <b>گزارش تسویه معامله تک مرحله‌ای (${exitReason})</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
🛡️ <b>اهرم اصلی:</b> <code>${order.leverage || 20}x</code>
💰 <b>قیمت ورود اصلی:</b> <code>$${this.formatPrice(order.entry_price)}</code>
🚪 <b>قیمت خروج نهایی:</b> <code>$${this.formatPrice(actualExitPrice)}</code>
📝 <b>علت خروج:</b> <code>${exitReason}</code>

🏆 <b>برآیند نهایی کل معامله:</b>
  ├ 💹 <b>درصد بازدهی نهایی:</b> <b><code>${total_pnl_pct >= 0 ? "+" : ""}${total_pnl_pct.toFixed(2)}%</code></b>
  ├ 💵 <b>سود/ضرر دلاری:</b> <b><code>${total_pnl_usd >= 0 ? "+" : ""}$${total_pnl_usd.toFixed(2)}</code></b>
  └ 💰 <b>کل موجودی حساب/دارایی:</b> <code>$${this.rm.capital.toFixed(2)}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
        `.trim();
      }

      await this.reporter.send(reportMsg);
    }
  }

  constructor(client: XTClient, reporter: TelegramReporter, config: Config) {
    this.client = client;
    this.reporter = reporter;
    this.config = config;
    this.rm = new RiskManager(config.BASE_CAPITAL, config.KELLY_FRACTION, config.POSITION_SIZE_MAX, config.MAX_DRAWDOWN);
    this.exitEngine = new AdaptiveExitEngine({
      trailingEnabled: config.TRAILING_STOP_ENABLED,
      earlyExitEnabled: config.EARLY_LOSS_EXIT_ENABLED,
      earlyExitMinLossRatio: config.EARLY_EXIT_MIN_LOSS_RATIO,
      momentumZThreshold: config.EARLY_EXIT_MOMENTUM_Z,
      confirmTicks: config.EARLY_EXIT_CONFIRM_TICKS,
    });
    this.positionGuard = new PositionGuard(this.client, this.corrMgr);
    this.engine.sensitivity = this.sensitivity === "auto_cortex" ? this.calculateCortexDynamicSensitivity() : this.sensitivity;
    this.loadState().catch(console.error);
  }

  public async saveState() {
    if (!this.isStateLoaded) {
      console.warn("Skipping saveState: State is still loading from disk...");
      return;
    }
    try {
      const state = {
        count: this.count,
        orders: this.orders,
        closedOrders: this.closedOrders,
        scanLogs: this.scanLogs.slice(0, 50),
        apiKey: this.apiKey,
        secretKey: this.secretKey,
        tradingMode: this.tradingMode,
        sensitivity: this.sensitivity,
        disable9Layers: this.disable9Layers,
        rejectedSignals: this.rejectedSignals,
        demoCapital: this.rm.capital,
        totalTrades: this.rm.totalTrades,
        winTrades: this.rm.winTrades,
        consecutiveLosses: this.consecutiveLosses,
        adaptiveSensitivityOverride: this.adaptiveSensitivityOverride,
        leverageMultiplier: this.leverageMultiplier,
        riskReductionMap: this.riskReductionMap,
        diagnosticLogs: this.diagnosticLogs,
        strategy: this._strategy,
        welcomeSent: this.welcomeSent,
        coinRotationEnabled: this.coinRotationEnabled,
        selectedCoins: this.selectedCoins,
        lastRotationAt: this.lastRotationAt,
      };
      await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("Failed to save state:", e);
    }
  }

  private async loadState() {
    try {
      const data = await fs.readFile(this.stateFilePath, "utf-8");
      const state = JSON.parse(data);
      this.count = state.count || 0;
      this.orders = state.orders || [];
      this.closedOrders = state.closedOrders || [];
      this.scanLogs = state.scanLogs || [];
      this.apiKey = state.apiKey || "";
      this.secretKey = state.secretKey || "";
      this.tradingMode = state.tradingMode || "simulation";
      this.sensitivity = state.sensitivity || "auto_cortex";
      this.disable9Layers = !!state.disable9Layers;
      this.rejectedSignals = state.rejectedSignals || [];
      this.consecutiveLosses = state.consecutiveLosses || 0;
      this.adaptiveSensitivityOverride = state.adaptiveSensitivityOverride || null;
      this.leverageMultiplier = state.leverageMultiplier !== undefined ? state.leverageMultiplier : 1.0;
      this.riskReductionMap = state.riskReductionMap || {};
      this.diagnosticLogs = state.diagnosticLogs || [];
      this.strategy = state.strategy && (state.strategy === "strict_elitescalp" || state.strategy === "active_goldenscalp" || state.strategy === "auto_cortex" || state.strategy === "auto") ? state.strategy : "auto";
      this.welcomeSent = !!state.welcomeSent;
      this.coinRotationEnabled = !!state.coinRotationEnabled;
      this.selectedCoins = state.selectedCoins || [];
      this.lastRotationAt = state.lastRotationAt || null;
      
      // Restore Risk Manager Capital and stats
      this.rm.capital = state.demoCapital !== undefined ? state.demoCapital : this.config.BASE_CAPITAL;
      this.rm.totalTrades = state.totalTrades || 0;
      this.rm.winTrades = state.winTrades || 0;

      this.initCcxt();
      this.isStateLoaded = true;
      this._addLog(`System state restored. Sensitivity set to: ${this.sensitivity}`);
    } catch (e) {
      this.sensitivity = "auto_cortex";
      this.strategy = "auto";
      this.disable9Layers = false;
      this.isStateLoaded = true;
      this._addLog("Fresh system initialization. No previous state found.");
    }
  }

  /**
   * اجرای کامل فرآیند انتخاب ۵ ارز برتر: غربال نقدینگی یک‌ساله + بک‌تست TrendPulse
   * روی کاندیداها + انتخاب بهترین‌ها بر اساس نرخ برد واقعی. نتیجه ذخیره و به
   * تلگرام ارسال می‌شود. این عملیات چند دقیقه طول می‌کشد (به دلیل محدودیت نرخ
   * درخواست صرافی XT) و در پس‌زمینه، مستقل از چرخه‌ی اصلی اسکن اجرا می‌شود.
   */
  public async runCoinRotation(force = false): Promise<CoinRotationReport | null> {
    if (this.rotationInProgress) {
      this._addLog("درخواست چرخش ارز نادیده گرفته شد: یک اجرای دیگر در حال انجام است.");
      return null;
    }
    const intervalMs = this.rotationIntervalDays * 24 * 60 * 60 * 1000;
    if (!force && this.lastRotationAt && Date.now() - this.lastRotationAt < intervalMs) {
      return null;
    }

    this.rotationInProgress = true;
    this._addLog("🔎 شروع بررسی هفتگی: غربال نقدینگی یک‌ساله و بک‌تست TrendPulse روی کل بازار...");
    try {
      const report = await selectTopCoins(this.client);
      this.lastRotationReport = report;
      this.selectedCoins = report.top5;
      this.lastRotationAt = Date.now();

      this._addLog(`🏆 چرخش ارز کامل شد: از ${report.universeSize} نماد، ${report.liquidityShortlistSize} کاندیدای پرنقدینگی بک‌تست شدند و ${report.qualifiedCount} نماد واجد شرایط بودند.`);
      await this.reporter.sendCoinRotationReport(report);
      await this.saveState();
      return report;
    } catch (e: any) {
      this._addLog(`خطا در فرآیند چرخش ارز: ${e?.message || e}`);
      return null;
    } finally {
      this.rotationInProgress = false;
    }
  }

  /** حلقه‌ی پس‌زمینه‌ای که هر ۳۰ دقیقه بررسی می‌کند آیا زمان چرخش هفتگی بعدی رسیده است */
  public async runCoinRotationScheduler() {
    while (this.isRunning) {
      try {
        if (this.coinRotationEnabled) {
          await this.runCoinRotation(false);
        }
      } catch (e) {
        console.error("Coin rotation scheduler error:", e);
      }
      const stepMs = 30 * 60 * 1000;
      let elapsed = 0;
      while (elapsed < stepMs && this.isRunning) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        elapsed += 5000;
      }
    }
  }

  public calculateCortexDynamicSensitivity(): "conservative" | "balanced" | "active" {
    // 1. Strict Risk control lock if there are multiple consecutive losses
    if (this.consecutiveLosses >= 2) {
      return "conservative";
    }

    // 2. Control volatility lock (such as large BTC fluctuations dragging everything)
    if (this.btcChange > 0.035 || this.btcChange < -0.035) {
      return "conservative";
    }

    // 3. Performance-based adaptive feedback (examine last 6 trades)
    const recentTrades = this.closedOrders.slice(0, 6);
    if (recentTrades.length < 2) {
      return "balanced"; // Boot-up / Standard baseline
    }

    const wins = recentTrades.filter(o => {
      // Calculate win based on positive realized PnL
      const pnlUsd = o.pnl_usd !== undefined ? o.pnl_usd : (o.tp1_pnl_usd || 0) + (o.tp2_pnl_usd || 0);
      return pnlUsd >= 0;
    }).length;
    
    const winRate = wins / recentTrades.length;

    if (winRate >= 0.60) {
      // The current market regime correlates highly with our models -> Be aggressive (active) to capture the edge is winning
      return "active";
    } else if (winRate < 0.40) {
      // Drawdown detected -> Be defensive (conservative)
      return "conservative";
    }

    // Balanced range between 40% and 60% win rate
    return "balanced";
  }

  public calculateCortexDynamicStrategy(): "strict_elitescalp" | "active_goldenscalp" {
    // 1. Pivot immediately to strict_elitescalp if we are facing consecutive losses
    if (this.consecutiveLosses >= 1) {
      return "strict_elitescalp";
    }

    // 2. Control volatility lock (large BTC fluctuations)
    if (this.btcChange > 0.03 || this.btcChange < -0.03) {
      return "strict_elitescalp";
    }

    // 3. Performance-based adaptive strategy selecting (examine last 6 trades)
    const recentTrades = this.closedOrders.slice(0, 6);
    if (recentTrades.length < 2) {
      return "active_goldenscalp"; // Start with the highly active golden scalp
    }

    const wins = recentTrades.filter(o => {
      const pnlUsd = o.pnl_usd !== undefined ? o.pnl_usd : (o.tp1_pnl_usd || 0) + (o.tp2_pnl_usd || 0);
      return pnlUsd >= 0;
    }).length;
    
    const winRate = wins / recentTrades.length;

    if (winRate >= 0.50) {
      // Market regime correlates highly with our models - be active!
      return "active_goldenscalp";
    }

    // Otherwise, be conservative and defensive
    return "strict_elitescalp";
  }

  private _getCoinDetails(symbol: string) {
    return {
      market_link: `https://www.xt.com/en/trade/${symbol.toLowerCase()}_usdt`,
      tradingview_link: `https://www.tradingview.com/symbols/${symbol}USDT`,
      search_link: `https://www.google.com/search?q=${symbol}+USDT+coin`,
    };
  }

  private _addLog(msg: string) {
    const timestamp = new Date().toLocaleTimeString();
    this.scanLogs.unshift(`[${timestamp}] ${msg}`);
    if (this.scanLogs.length > 50) this.scanLogs.pop();
    console.log(msg);
  }

  /**
   * 🧠 Smart Risk-Reduction Lookup (replaces hard quarantine blocking)
   *
   * Returns the currently-active risk-reduction adjustments for a given symbol
   * (and optionally its correlation group), with linear decay over time:
   *  - sizeFactor: multiplier applied to position size (1 = no reduction)
   *  - extraConfidence: extra win-probability the engine must clear before entry
   *
   * The symbol/group is NEVER fully blocked — only made smaller and harder to
   * trigger for a while after a loss, recovering smoothly back to normal.
   */
  private _getRiskReduction(symbol: string, group?: string | null): { sizeFactor: number; extraConfidence: number; active: boolean } {
    const now = Date.now();
    const entries: { until: number; startedAt: number; sizeFactor: number; extraConfidence: number }[] = [];

    const symEntry = this.riskReductionMap[symbol];
    if (symEntry && symEntry.until > now) entries.push(symEntry);

    if (group) {
      const groupEntry = this.riskReductionMap[group];
      if (groupEntry && groupEntry.until > now) entries.push(groupEntry);
    }

    if (entries.length === 0) return { sizeFactor: 1, extraConfidence: 0, active: false };

    // Combine multiple active reductions (symbol + group) by taking the strictest values,
    // each scaled by how much of its decay window remains.
    let sizeFactor = 1;
    let extraConfidence = 0;
    for (const e of entries) {
      const totalSpan = Math.max(1, e.until - e.startedAt);
      const remaining = Math.max(0, e.until - now);
      const progress = Math.max(0, Math.min(1, remaining / totalSpan)); // 1 -> just started, 0 -> fully decayed

      const currentSizeFactor = 1 - (1 - e.sizeFactor) * progress;
      const currentExtraConfidence = e.extraConfidence * progress;

      sizeFactor = Math.min(sizeFactor, currentSizeFactor);
      extraConfidence = Math.max(extraConfidence, currentExtraConfidence);
    }

    return { sizeFactor, extraConfidence, active: true };
  }

  /**
   * Apply a temporary, decaying risk-reduction to a symbol (and optionally its
   * correlation group) instead of fully quarantining it.
   */
  private _applyRiskReduction(key: string, durationMs: number, sizeFactor: number, extraConfidence: number) {
    const now = Date.now();
    this.riskReductionMap[key] = {
      startedAt: now,
      until: now + durationMs,
      sizeFactor,
      extraConfidence,
    };
  }

  async scan() {
    const scanStartedAt = Date.now();
    this.count++;
    this._addLog(`Scan #${this.count} starting...`);
    this.currentProgress = "در حال دریافت داده بازار...";
    try {
      const allPairs = await this.client.getAllUsdtPairs(true);
      if (!allPairs.length) {
        this._addLog("No pairs found on XT.");
        return [];
      }

      const btcPair = allPairs.find((p) => p.clean === "BTC");
      this.btcChange = btcPair ? btcPair.change_24h : 0;

      // Real-time Live Position Price & PnL Tracker (exits are fully evaluated by the dedicated high-frequency tracker)
      const activePositions = this.orders.filter(o => o.status === "filled");
      if (activePositions.length > 0) {
        this._addLog(`Updating prices for ${activePositions.length} active positions...`);
        for (const order of this.orders) {
          if (order.status === "filled") {
            const liveTicker = allPairs.find(p => p.symbol.toLowerCase() === order.symbol.toLowerCase() || p.clean.toLowerCase() === order.symbol.toLowerCase());
            const currentPrice = liveTicker ? liveTicker.price : 0;
            if (currentPrice > 0) {
              order.current_price = currentPrice;
              
              // Calculate live tracking PnL%
              let pnlPct = 0;
              if (order.action === "buy") {
                pnlPct = ((currentPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
              } else {
                pnlPct = ((order.entry_price - currentPrice) / order.entry_price) * 100 * (order.leverage || 1);
              }
              order.pnl_pct = pnlPct;
              order.pnl_usd = (pnlPct / 100) * order.position_value;
            }
          }
        }
        await this.saveState();
      }

      const topVolume = this.coinRotationEnabled && this.selectedCoins.length > 0
        ? allPairs.filter((p) => this.selectedCoins.some((c) => c.clean === p.clean))
        : allPairs.slice(0, this.config.TOP_TICKER_FILTER);
      const obCandidates: any[] = [];

      this._addLog(`Parallel Filtering: Checking top ${this.config.ORDERBOOK_FILTER} pairs...`);
      
      // Parallel Orderbook Check with concurrency control (limit of 10 at once)
      const batchSize = 10;
      for (let i = 0; i < Math.min(topVolume.length, this.config.ORDERBOOK_FILTER); i += batchSize) {
        const batch = topVolume.slice(i, i + batchSize);
        this.currentProgress = `تحلیل اردربوک: دسته ${Math.floor(i/batchSize) + 1} (${i + 1}-${Math.min(i + batchSize, this.config.ORDERBOOK_FILTER)})`;
        
        const results = await Promise.all(batch.map(async (pair) => {
          try {
            const ob = await this.client.getOrderbook(pair.symbol, 50);
            if (ob && ob.bids.length && ob.asks.length) {
              const bv = ob.bids.slice(0, 20).reduce((s, b) => s + b[1], 0);
              const av = ob.asks.slice(0, 20).reduce((s, a) => s + a[1], 0);
              const total = bv + av;
              if (total > 0 && Math.abs(bv - av) / total > 0.02) {
                return { pair, ob };
              }
            }
          } catch (e) {}
          return null;
        }));
        
        obCandidates.push(...results.filter((r): r is any => r !== null));
      }

      this._addLog(`Deep Deep Intel: Processing ${obCandidates.length} high-potential pools...`);
      const signals: Position[] = [];
      
      // Parallel Deep Analysis (Batch of 5)
      for (let i = 0; i < Math.min(obCandidates.length, this.config.DEEP_ANALYSIS); i += 5) {
        const batch = obCandidates.slice(i, i + 5);
        this.currentProgress = `تحلیل عمیق سیگنال: دارایی ${i + 1} تا ${Math.min(i + 5, obCandidates.length)}`;
        
        await Promise.all(batch.map(async ({ pair, ob }) => {
          try {
            const baseSensitivity = this.sensitivity === "auto_cortex" ? this.calculateCortexDynamicSensitivity() : this.sensitivity;
            this.engine.sensitivity = this.adaptiveSensitivityOverride || baseSensitivity;

            const baseStrategy = this.strategy === "auto_cortex" ? this.calculateCortexDynamicStrategy() : this.strategy;
            this.engine.strategy = baseStrategy;

            // Guard against scanning symbols that already have an active/live tracking order open
            const hasActivePos = this.orders.some(o => o.symbol === pair.clean && o.status === "filled");
            if (hasActivePos) {
              this._addLog(`🛡️ [Active Position Guard] Skipping candidate ${pair.clean} from scanning because it already has an active open trade.`);
              return;
            }

            // 🧠 Smart Risk-Reduction (replaces old hard quarantine block):
            // the symbol is always scanned; if it recently lost, we apply a temporary
            // reduced position size and require extra confidence to enter, both of
            // which decay smoothly back to normal over a few hours.
            const group = this.corrMgr.getGroupDescription(pair.clean);
            const riskReduction = this._getRiskReduction(pair.clean, group);
            this.engine.extraMinConfidence = riskReduction.extraConfidence;
            if (riskReduction.active) {
              this._addLog(`🛡️ [Smart Risk Guard] ${pair.clean}${group ? ` (group "${group}")` : ""}: کاهش حجم به ${(riskReduction.sizeFactor * 100).toFixed(0)}٪ و افزایش حدنصاب اعتماد +${(riskReduction.extraConfidence * 100).toFixed(1)}٪ به دلیل زیان اخیر.`);
            }


            // حداقل ۳۰۰ کندل ۵ دقیقه‌ای (~۲۵ ساعت) لازم است تا استراتژی TrendPulse بتواند
            // یک تایم‌فریم ۱ ساعته‌ی مصنوعی قابل‌اتکا برای تشخیص روند بسازد.
            const klines = await this.client.getKlines(pair.symbol, "5m", 300);
            if (!klines || klines.close.length < 60) return;

            const sig = await this.engine.analyze(pair.clean, klines, ob, pair.change_24h, this.btcChange, pair.price);
            if (sig) {
              if (sig.action !== "stay_out") {
                const activeCount = this.orders.filter(o => o.status === "filled").length;
                if (activeCount >= 5) {
                  this._addLog(`⚠️ [Limit Exceeded] Signal for ${sig.symbol} skipped because max open positions limit (5) has been reached.`);
                  if (!this.rejectedSignals.find(r => r.symbol === sig.symbol && (Date.now() - r.time < 15 * 60 * 1000))) {
                    this.rejectedSignals.push({
                      symbol: sig.symbol,
                      action: sig.action,
                      score: sig.score,
                      threshold: sig.dynamic_threshold,
                      reason: "حداکثر ظرفیت ۵ معامله فعال تکمیل است",
                      time: Date.now()
                    });
                    if (this.rejectedSignals.length > 100) {
                      this.rejectedSignals.shift();
                    }
                  }
                  return;
                }

                const details = this._getCoinDetails(sig.symbol);
                Object.assign(sig, details);

                // RE-FETCH FRESH LIVE PRICE RIGHT BEFORE SIGNAL ISSUANCE TO ELIMINATE ANY LAG
                const freshPrice = await this.client.getLivePrice(sig.symbol);
              if (freshPrice && freshPrice > 0) {
                const ratio = freshPrice / sig.price;
                sig.price = freshPrice;
                sig.stop_loss = sig.stop_loss * ratio;
                sig.take_profit = sig.take_profit * ratio;
                sig.take_profit_2 = sig.take_profit_2 * ratio;
              }

              if (this.orders.filter(o => o.status === "filled").length >= 5) {
                this._addLog(`⚠️ [Limit Exceeded] Skip order execution for ${sig.symbol} because max limit (5) has been reached.`);
                return;
              }

              // Apply adaptive self-correction leverage scaling (global) +
              // per-symbol smart risk-reduction (local, decaying)
              const rawLeverage = sig.leverage || 20;
              sig.leverage = Math.max(2, Math.round(rawLeverage * this.leverageMultiplier * riskReduction.sizeFactor));

              const risk = this.rm.calculatePosition(sig.score, sig.price, sig.daily_vol);
              
              // Scale position size using global leverageMultiplier and the
              // symbol-specific smart risk-reduction factor (1 = no reduction)
              risk.position_size = risk.position_size * this.leverageMultiplier * riskReduction.sizeFactor;
              risk.quantity = risk.position_size / sig.price;

              const corrCheck = this.corrMgr.checkCorrelationLimit(sig.symbol, this.orders, risk.position_size, this.rm.capital);

              if (corrCheck.allowed && corrCheck.adjusted_size > 0) {
                risk.position_size = corrCheck.adjusted_size;
                risk.quantity = risk.position_size / sig.price;
                sig.correlation_group = this.corrMgr.getGroupDescription(sig.symbol);
                sig.correlation_warning = corrCheck.warning;

                let isRealOrderSuccess = true;
                let realQuantity = risk.quantity;
                let realEntryPrice = sig.price;
                let realOrderId = `o${Date.now()}-${sig.symbol}`;

                if (this.tradingMode === "real") {
                  if (sig.action === "buy") {
                    this._addLog(`🚀 [REAL MODE] Dispatching REAL MARKET BUY order on XT for ${sig.symbol}...`);
                    try {
                      if (!this.ccxtExchange) {
                        throw new Error("تنظیمات یا کلیدهای امنیتی Private API صرافی جهت اجرای معامله واقعی یافت نشد.");
                      }

                      const ccxtSym = sig.symbol.toUpperCase().replace("_", "/");
                      let executionQty = risk.quantity;

                      // Check balance and scale order to fit wallet
                      const balance = await this.ccxtExchange.fetchBalance();
                      const freeUsdt = balance?.free?.USDT || 0;
                      this._addLog(`💳 موجودی زنده واقعی: ${freeUsdt.toFixed(2)} USDT. ارزش موقعیت محاسبه شده: ${risk.position_size.toFixed(2)} USDT.`);

                      if (freeUsdt < risk.position_size) {
                        if (freeUsdt > 6) {
                          const scaleRatio = (freeUsdt - 1) / risk.position_size;
                          executionQty = executionQty * scaleRatio;
                          risk.position_size = freeUsdt - 1;
                          this._addLog(`⚠️ کسر بودجه: ارزش خرید به ${risk.position_size.toFixed(2)} USDT کاهش یافت تا با موجودی همگام شود.`);
                        } else {
                          throw new Error(`موجودی تتر کافی نیست (${freeUsdt.toFixed(2)} USDT). حداقل ۶ تتر مورد نیاز است.`);
                        }
                      }

                      // Execute Market Buy via CCXT
                      this._addLog(`در حال ارسال سفارش خرید مارکت به صرافی: ${ccxtSym} به مقدار ${executionQty}`);
                      const response = await this.ccxtExchange.createMarketBuyOrder(ccxtSym, executionQty);

                      if (response && response.id) {
                        realOrderId = response.id;
                        realQuantity = response.filled || response.amount || executionQty;
                        realEntryPrice = response.average || response.price || sig.price;
                        this._addLog(`✅ سفارش واقعی خرید با موفقیت پر شد! شناسه سفارش: ${realOrderId}. مقدار: ${realQuantity}، قیمت میانگین: ${realEntryPrice}`);
                      } else {
                        throw new Error("صرافی سفارش خرید مارکت را بدون شناسه دریافت ثبت کرد.");
                      }
                    } catch (orderErr: any) {
                      isRealOrderSuccess = false;
                      const msg = `❌ [REAL ORDER FAILED] خطا در ثبت معامله واقعی برای ${sig.symbol}: ${orderErr.message || orderErr}`;
                      this._addLog(msg);
                      await this.reporter.send(`🚨 <b>عملیات خرید واقعی شکست خورد!</b>\n\nجفت‌ارز: <b>${sig.symbol}/USDT</b>\nخطا: <code>${orderErr.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\nسیستم این موقعیت را برای حفظ سرمایه شما رد کرد.`);
                    }
                  } else {
                    isRealOrderSuccess = false;
                    this._addLog(`⚠️ [REAL MODE] موقعیت فروش (Short) در اسپات نادیده گرفته شد: ${sig.symbol}`);
                    await this.reporter.send(`⚠️ <b>سیگنال فروش (SHORT) نادیده گرفته شد</b>\n\nجفت ارز: <b>${sig.symbol}</b>\n\nصرافی XT در بخش اسپات معامله فروش تعهدی بدون مارجین را پشتیبانی نمی‌کند.`);
                  }
                }

                if (isRealOrderSuccess) {
                  const order: Position = {
                    id: realOrderId,
                    symbol: sig.symbol,
                    action: sig.action as "buy" | "sell",
                    quantity: realQuantity,
                    entry_price: realEntryPrice,
                    stop_loss: sig.stop_loss,
                    take_profit_1: sig.take_profit,
                    take_profit_2: sig.take_profit_2,
                    position_value: risk.position_size,
                    status: "filled",
                    mode: this.tradingMode,
                    score: sig.score,
                    confidence: sig.confidence,
                    daily_vol: sig.daily_vol,
                    regime: sig.regime,
                    vol_surge: sig.vol_surge,
                    vol_surge_msg: sig.vol_surge_msg,
                    imbalance: sig.imbalance,
                    iceberg: sig.iceberg,
                    pain_point: sig.pain_point,
                    divergence: sig.divergence,
                    ml_weights: sig.ml_weights,
                    dynamic_threshold: sig.dynamic_threshold,
                    sub_signals: sig.sub_signals,
                    leverage: sig.leverage,
                    created_at: Date.now(),
                    current_price: sig.price,
                    pnl_pct: 0,
                    pnl_usd: 0,
                    tp1_hit: false,
                    initial_position_value: risk.position_size,
                    initial_quantity: realQuantity,
                    tp1_pnl_usd: 0,
                    tp1_pnl_pct: 0,
                    tp2_pnl_usd: 0,
                    tp2_pnl_pct: 0,
                  };

                  // Prevent duplicates
                  if (!this.orders.find(o => o.symbol === order.symbol)) {
                    this.orders.push(order);
                    if (this.orders.length > 30) this.orders.shift();
                    await this.reporter.sendSignal(sig, risk);
                    signals.push(order);
                    this._addLog(`🎯 RAID SUCCESS: SIGNAL FOR ${order.symbol} DISPATCHED`);
                    await this.saveState();
                  }
                }
              }
            } else {
              const isBuyAttempt = sig.score >= 0.52;
              const isSellAttempt = sig.score <= 0.48;
              if (isBuyAttempt || isSellAttempt) {
                const trackingReason = sig.veto_reason || `امتیاز ${sig.score.toFixed(2)} کمتر از آستانه پویای ${sig.dynamic_threshold.toFixed(2)} است`;
                
                if (sig.veto_reason && sig.veto_reason.includes("کمتر از حدنصاب حساسیت انتخابی شما")) {
                  this._addLog(`🧠 [Cortex Self-Optimization] Vetoed candidate trade for ${pair.clean}: ${sig.veto_reason}`);
                  
                  // 🧠 Smart Risk-Reduction (short & gentle): rather than a hard 2-hour
                  // ban, slightly raise this symbol's confidence bar for 20 minutes.
                  // This decays back to normal automatically and never fully blocks the symbol.
                  const vetoRiskWindow = 20 * 60 * 1000; // 20 minutes
                  this._applyRiskReduction(pair.clean, vetoRiskWindow, 0.85, 0.02);
                  this._addLog(`🛡️ [Smart Risk Guard] ${pair.clean}: افزایش موقت و کوتاه‌مدت (۲۰ دقیقه) حدنصاب اعتماد به دلیل وتوی کورتکس، بدون توقف کامل اسکن.`);
                  
                  // Avoid flooding duplicates for same token in recent logs (30 mins)
                  const alreadyLogged = this.diagnosticLogs.some(
                    l => l.symbol === pair.clean && l.type === "self_correction" && (Date.now() - l.time < 30 * 60 * 1000)
                  );
                  
                  if (!alreadyLogged) {
                    this.diagnosticLogs.unshift({
                      id: `veto-${Date.now()}-${pair.clean}`,
                      time: Date.now(),
                      symbol: pair.clean,
                      type: "self_correction",
                      title: `خودبهینه‌سازی و وتوی معامله ${pair.clean}`,
                      message: sig.veto_reason,
                      actionTaken: "جلوگیری خودکار از ورود به موقعیت به دلیل شباهت بالا به ساختارهای منتهی به زیان تاریخی ربات."
                    });
                    if (this.diagnosticLogs.length > 50) {
                      this.diagnosticLogs = this.diagnosticLogs.slice(0, 50);
                    }
                  }
                  await this.saveState();
                }

                // Prevent duplicating the exact same pair within 15 minutes
                if (!this.rejectedSignals.find(r => r.symbol === sig.symbol && (Date.now() - r.time < 15 * 60 * 1000))) {
                  this.rejectedSignals.push({
                    symbol: sig.symbol,
                    action: isBuyAttempt ? "buy" : "sell",
                    score: sig.score,
                    threshold: sig.dynamic_threshold,
                    reason: trackingReason,
                    time: Date.now()
                  });
                  if (this.rejectedSignals.length > 100) {
                    this.rejectedSignals.shift();
                  }
                }
              }
            }
          }
          } catch (e: any) {
            this.lastError = `Deep Log Error: ${pair.symbol} - ${e.message}`;
          }
        }));
      }

      const scannedAssetCount = Math.min(topVolume.length, this.config.ORDERBOOK_FILTER);
      const scanDurationMs = Date.now() - scanStartedAt;
      this.lastScanDurationMs = scanDurationMs;
      this.lastScanAssetCount = scannedAssetCount;
      this.lastScanAssetsPerSec = scanDurationMs > 0 ? (scannedAssetCount / (scanDurationMs / 1000)) : null;

      this.lastScanTime = Date.now();
      this.currentProgress = "اسکن کامل شد - در حالت استراحت تا چرخه بعدی.";
      this._addLog(`Scan #${this.count} complete. Signals generated: ${signals.length}`);
      this.reporter.sendScannedCoins(obCandidates.map((c) => c.pair.clean)).catch(() => {});
      await this.saveState();
      return signals;
    } catch (e: any) {
      this.lastError = `Scan Global Error: ${e.message}`;
      this._addLog(`Critical Error: ${e.message}`);
      return [];
    }
  }

  // Live tracking & high frequency price target evaluator (runs every 2 seconds for active positions)
  private async runHighFrequencyLiveTracker() {
    this._addLog("سامانه رهگیری لحظه‌ای و پرسرعت موقعیت‌های فعال فعال‌سازی شد (تناوب ۲ ثانیه).");
    while (this.isRunning) {
      try {
        const activePositions = this.orders.filter(o => o.status === "filled");
        if (activePositions.length > 0) {
          let hasChange = false;

          for (const order of this.orders) {
            if (order.status === "filled") {
              // Direct un-cached live price retrieval based on real-time orderbook depth
              const livePrice = await this.client.getLivePrice(order.symbol);
              
              if (livePrice && livePrice > 0 && livePrice !== order.current_price) {
                order.current_price = livePrice;
                hasChange = true;

                // Calculate accurate live PnL%
                let pnlPct = 0;
                if (order.action === "buy") {
                  pnlPct = ((livePrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
                } else {
                  pnlPct = ((order.entry_price - livePrice) / order.entry_price) * 100 * (order.leverage || 1);
                }
                order.pnl_pct = pnlPct;
                order.pnl_usd = (pnlPct / 100) * order.position_value;

                // 🛡️ Gather market-pressure context: volatility regime (ATR%), sector/correlation
                // stress (are correlated positions losing together?), and whether the original
                // signal thesis still holds. These combine into ONE decision below, not four
                // separate independent checks.
                const [atrPct, invalidation] = await Promise.all([
                  this.positionGuard.getAtrPct(order.symbol),
                  this.positionGuard.checkSignalInvalidated(order),
                ]);
                const correlationStress = this.positionGuard.getCorrelationStress(order, this.orders);

                // 🧠 Adaptive Exit Engine: profit-lock trailing stop + smart early-loss exit,
                // now market-pressure aware (ATR-scaled sensitivity, correlation stress,
                // signal invalidation, and partial de-risking).
                // Runs before the fixed SL/TP check so a tightened stop or an early-exit
                // signal takes effect on this same tick.
                const exitDecision = this.exitEngine.evaluate(order, livePrice, pnlPct, {
                  atrPct: atrPct ?? undefined,
                  correlationStress,
                  signalInvalidated: invalidation.invalidated,
                  invalidationReason: invalidation.reason,
                });

                if (exitDecision.shouldPartialCut && !exitDecision.shouldEarlyExit) {
                  await this.handlePartialLossCut(order, livePrice, exitDecision.partialCutFraction || 0.4, exitDecision.partialCutReason || "");
                }

                if (exitDecision.newStopLoss !== undefined) {
                  if (!order.original_stop_loss) order.original_stop_loss = order.stop_loss;
                  order.stop_loss = exitDecision.newStopLoss;
                  order.trailing_active = true;
                  if (exitDecision.trailTierChanged) {
                    this._addLog(`🔒 [${order.symbol}] قفل سود فعال شد/تنگ‌تر شد — حد ضرر جدید: ${this.formatPrice(order.stop_loss)} (سود جاری: ${pnlPct.toFixed(2)}%)`);
                    await this.reporter.send(`
🔒 <b>قفل سود فعال شد (Trailing Stop)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
📈 <b>قیمت فعلی:</b> <code>$${this.formatPrice(livePrice)}</code>
🟢 <b>سود جاری:</b> <code>+${pnlPct.toFixed(2)}%</code>
🛡️ <b>حد ضرر جدید (قفل‌شده):</b> <code>$${this.formatPrice(order.stop_loss)}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
                    `.trim());
                  }
                }

                let shouldExit = false;
                let exitReason = "";
                let exitPrice = livePrice;

                if (exitDecision.shouldEarlyExit) {
                  shouldExit = true;
                  exitReason = "خروج هوشمند زودهنگام (Smart Early-Loss Exit)";
                  exitPrice = livePrice;
                  this._addLog(`🧠 [${order.symbol}] ${exitDecision.earlyExitReason} — بستن پوزیشن قبل از رسیدن به حد ضرر کامل.`);
                  await this.reporter.send(`
🧠 <b>خروج هوشمند زودهنگام فعال شد</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
📉 <b>قیمت فعلی (خروج):</b> <code>$${this.formatPrice(livePrice)}</code>
🔴 <b>زیان جاری:</b> <code>${pnlPct.toFixed(2)}%</code>
📝 <b>علت:</b> <code>${exitDecision.earlyExitReason}</code>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت دارایی اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
                  `.trim());
                } else if (order.action === "buy") {
                  if (livePrice <= order.stop_loss) {
                    shouldExit = true;
                    exitReason = order.trailing_active ? "قفل سود متحرک (Trailing Stop)" : "Stop Loss (حد ضرر)";
                    exitPrice = order.stop_loss;
                  } else if (livePrice >= order.take_profit_2) {
                    shouldExit = true;
                    exitReason = "Take Profit 2 (حد سود کامل)";
                    exitPrice = order.take_profit_2;
                  } else if (livePrice >= order.take_profit_1 && !order.tp1_hit) {
                    await this.handleTakeProfit1(order, livePrice);
                  }
                } else {
                  if (livePrice >= order.stop_loss) {
                    shouldExit = true;
                    exitReason = order.trailing_active ? "قفل سود متحرک (Trailing Stop)" : "Stop Loss (حد ضرر)";
                    exitPrice = order.stop_loss;
                  } else if (livePrice <= order.take_profit_2) {
                    shouldExit = true;
                    exitReason = "Take Profit 2 (حد سود کامل)";
                    exitPrice = order.take_profit_2;
                  } else if (livePrice <= order.take_profit_1 && !order.tp1_hit) {
                    await this.handleTakeProfit1(order, livePrice);
                  }
                }

                if (shouldExit) {
                  await this.closeActivePosition(order.id, exitPrice, exitReason);
                }
              }
            }
          }

          const closed = this.orders.filter(o => o.status === "closed");
          if (closed.length > 0) {
            this.closedOrders.unshift(...closed);
            if (this.closedOrders.length > 100) {
              this.closedOrders = this.closedOrders.slice(0, 100);
            }
            this.orders = this.orders.filter(o => o.status !== "closed");
            hasChange = true;
          }

          if (hasChange) {
            await this.saveState();
          }
        }
      } catch (err) {
        console.error("Error in high frequency scanner update:", err);
      }
      // Reduced to sub-second polling interval (750ms) to guarantee split-second tracking execution and exchange sync
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  // 🎯 Unified High-Reliability 50% Partial Target Closer & CCXT Broker Integrator
  private async handleTakeProfit1(order: any, currentPrice: number) {
    if (order.tp1_hit) return;
    order.tp1_hit = true;
    order.stop_loss = order.entry_price; // 🛡️ Shift Stop-Loss to Breakeven (Risk-Free)

    let actualExitPrice = currentPrice;
    let isRealExitSuccess = true;
    const partialQty = order.quantity * 0.5;

    if (this.tradingMode === "real" && this.ccxtExchange) {
      if (order.action === "buy") {
        this._addLog(`🎯 [REAL MODE] TARGET 1 HIT: Triggering 50% REAL MARKET SELL for ${order.symbol}...`);
        try {
          const ccxtSym = order.symbol.toUpperCase().replace("_", "/");
          const response = await this.ccxtExchange.createMarketSellOrder(ccxtSym, partialQty);
          if (response && response.id) {
            actualExitPrice = response.average || response.price || currentPrice;
            this._addLog(`✅ XT Real Partial Sell (50%) filled! Order ID: ${response.id}. Price: ${actualExitPrice}`);
          }
        } catch (err: any) {
          isRealExitSuccess = false;
          this._addLog(`❌ [REAL PARTIAL SELL FAILED] ${err.message || err}`);
          await this.reporter.send(`🚨🚨 <b>خطا در فروش ۵۰ درصد پوزیشن واقعی در تارگت اول!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ سیستم به طور خودکار فاز مدیریت ریسک بدون ضرر را ادامه می‌دهد.`);
        }
      } else {
        this._addLog(`🎯 [REAL MODE] TARGET 1 HIT: Triggering 50% REAL MARKET COVER/BUY for ${order.symbol}...`);
        try {
          const ccxtSym = order.symbol.toUpperCase().replace("_", "/");
          const response = await this.ccxtExchange.createMarketBuyOrder(ccxtSym, partialQty);
          if (response && response.id) {
            actualExitPrice = response.average || response.price || currentPrice;
            this._addLog(`✅ XT Real Partial Cover (50%) filled! Order ID: ${response.id}. Price: ${actualExitPrice}`);
          }
        } catch (err: any) {
          isRealExitSuccess = false;
          this._addLog(`❌ [REAL PARTIAL COVER FAILED] ${err.message || err}`);
          await this.reporter.send(`🚨🚨 <b>خطا در خرید پوششی ۵۰ درصد پوزیشن واقعی در تارگت اول!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ سیستم به طور خودکار فاز مدیریت ریسک بدون ضرر را ادامه می‌دهد.`);
        }
      }
    }

    // Realize PnL of this 50% part
    let realizedPnlPct = 0;
    if (order.action === "buy") {
      realizedPnlPct = ((actualExitPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
    } else {
      realizedPnlPct = ((order.entry_price - actualExitPrice) / order.entry_price) * 100 * (order.leverage || 1);
    }
    const halfValue = order.position_value * 0.5;
    const realizedPnlUsd = (realizedPnlPct / 100) * halfValue;

    if (!order.initial_position_value) {
      order.initial_position_value = order.position_value;
    }
    if (!order.initial_quantity) {
      order.initial_quantity = order.quantity;
    }

    order.tp1_hit = true;
    order.tp1_exit_price = actualExitPrice;
    order.tp1_pnl_pct = realizedPnlPct;
    order.tp1_pnl_usd = realizedPnlUsd;

    if (this.tradingMode === "real") {
      await this.updateRealBalance();
      this.rm.capital = Math.max(10, this.realBalance);
    } else {
      this.rm.capital = Math.max(10, this.rm.capital + realizedPnlUsd);
    }

    // Shrink the current active position size by half to reflect partial exit
    order.quantity = order.quantity * 0.5;
    order.position_value = order.position_value * 0.5;

    this._addLog(`🎯 TARGET 1 HIT (50% CLOSED): ${order.symbol} closed 50% of trade at $${actualExitPrice}. Realized PnL: ${realizedPnlPct.toFixed(2)}% ($${realizedPnlUsd.toFixed(2)}). Remaining position resized to $${order.position_value.toFixed(2)}. Stop Loss shifted to Entry Price ($${order.entry_price}).`);
    
    // Send a beautifully designed, highly professional compact Persian Telegram confirmation
    await this.reporter.send(`
🎯 <b>سیگنال به تارگت اول رسید و ۵۰٪ معامله بسته شد!</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
🎯 <b>قیمت تارگت ۱:</b> <code>$${this.formatPrice(order.take_profit_1)}</code>
✨ <b>قیمت انجام معامله:</b> <code>$${this.formatPrice(actualExitPrice)}</code>

📊 <b>گزارش بازدهی بستن ۵۰ درصد معامله:</b>
🟢 <b>سود خالص درصد:</b> <code>+${realizedPnlPct.toFixed(2)}%</code>
💵 <b>سود خالص دلاری:</b> <code>$${realizedPnlUsd.toFixed(2)}</code>
📦 <b>ارزش باقیمانده معامله:</b> <code>$${order.position_value.toFixed(2)}</code>

🛡️ <b>مدیریت ریسک بدون ضرر (Breakeven):</b> حد ضررِ ۵۰ درصد مابقی معامله بر روی <b>قیمت ورود ($${this.formatPrice(order.entry_price)})</b> تنظیم شد. اکنون معامله کاملاً بدون ریسک (Risk-Free) به سمت تارگت دوم حرکت می‌کند.
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت ریسک اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
    `.trim());

    await this.saveState();
  }

  // 🩹 Partial De-risking: cuts a fraction of the remaining size while a position is under
  // loss pressure but before the full early-exit condition is confirmed — reduces risk
  // without fully giving up on a potential reversal. Fires at most once per trade.
  private async handlePartialLossCut(order: any, currentPrice: number, fraction: number, reason: string) {
    const cutQty = order.quantity * fraction;
    const cutValue = order.position_value * fraction;

    let actualExitPrice = currentPrice;

    if (this.tradingMode === "real" && this.ccxtExchange) {
      const ccxtSym = order.symbol.toUpperCase().replace("_", "/");
      try {
        if (order.action === "buy") {
          this._addLog(`🩹 [REAL MODE] PARTIAL LOSS-CUT: Selling ${(fraction * 100).toFixed(0)}% of ${order.symbol}...`);
          const response = await this.ccxtExchange.createMarketSellOrder(ccxtSym, cutQty);
          if (response && response.id) actualExitPrice = response.average || response.price || currentPrice;
        } else {
          this._addLog(`🩹 [REAL MODE] PARTIAL LOSS-CUT: Covering ${(fraction * 100).toFixed(0)}% of ${order.symbol}...`);
          const response = await this.ccxtExchange.createMarketBuyOrder(ccxtSym, cutQty);
          if (response && response.id) actualExitPrice = response.average || response.price || currentPrice;
        }
      } catch (err: any) {
        this._addLog(`❌ [PARTIAL LOSS-CUT FAILED] ${order.symbol}: ${err.message || err}`);
        await this.reporter.send(`🚨 <b>خطا در کاهش حجم پله‌ای پوزیشن واقعی!</b>\n\nجفت ارز: <b>${order.symbol}/USDT</b>\nخطا: <code>${err.message || "رویداد رد تراکنش یا سرریزی صرافی"}</code>\n\n⚠️ سیستم مدیریت ریسک به کار خود روی مابقی پوزیشن ادامه می‌دهد.`);
        return;
      }
    }

    let realizedPnlPct = 0;
    if (order.action === "buy") {
      realizedPnlPct = ((actualExitPrice - order.entry_price) / order.entry_price) * 100 * (order.leverage || 1);
    } else {
      realizedPnlPct = ((order.entry_price - actualExitPrice) / order.entry_price) * 100 * (order.leverage || 1);
    }
    const realizedPnlUsd = (realizedPnlPct / 100) * cutValue;

    if (!order.initial_position_value) order.initial_position_value = order.position_value;
    if (!order.initial_quantity) order.initial_quantity = order.quantity;

    order.quantity = order.quantity - cutQty;
    order.position_value = order.position_value - cutValue;

    if (this.tradingMode === "real") {
      await this.updateRealBalance();
      this.rm.capital = Math.max(10, this.realBalance);
    } else {
      this.rm.capital = Math.max(10, this.rm.capital + realizedPnlUsd);
    }

    this._addLog(`🩹 PARTIAL LOSS-CUT (${(fraction * 100).toFixed(0)}% CLOSED): ${order.symbol} at $${actualExitPrice}. Realized: ${realizedPnlPct.toFixed(2)}% ($${realizedPnlUsd.toFixed(2)}). Remaining: $${order.position_value.toFixed(2)}. Reason: ${reason}`);

    await this.reporter.send(`
🩹 <b>کاهش حجم پله‌ای (Partial De-risking)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
💰 <b>قیمت ورود:</b> <code>$${this.formatPrice(order.entry_price)}</code>
📉 <b>قیمت فعلی:</b> <code>$${this.formatPrice(actualExitPrice)}</code>
✂️ <b>درصد بسته‌شده:</b> <code>${(fraction * 100).toFixed(0)}٪</code>
🔴 <b>زیان شناسایی‌شده این بخش:</b> <code>${realizedPnlPct.toFixed(2)}%</code> (<code>$${realizedPnlUsd.toFixed(2)}</code>)
📦 <b>ارزش باقیمانده معامله:</b> <code>$${order.position_value.toFixed(2)}</code>
📝 <b>علت:</b> ${reason}
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه مدیریت ریسک اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
    `.trim());

    await this.saveState();
  }

  // 🧠 Core Cortex Self-Correction, Diagnostics, & Auto-Correction Engine
  public async autoDiagnoseAndAdapt(order: Position, finalPnl: number, finalPnlUsd: number) {
    if (finalPnl >= 0) {
      // WIN/PROFIT: Restore/heal adaptive parameters slowly!
      const previousLosses = this.consecutiveLosses;
      this.consecutiveLosses = 0;
      this.leverageMultiplier = 1.0;
      this.adaptiveSensitivityOverride = null;
      
      if (previousLosses > 0) {
        // Send recovery notification to Telegram
        await this.reporter.send(`
🟢 <b>سامانه بازیابی انطباقی کورتکس (Cortex Autorecovery Log)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز احیا کننده:</b> <code>${order.symbol}/USDT</code>
📈 <b>عملکرد تسویه:</b> سود خالص <code>+${finalPnl.toFixed(2)}%</code>

🔍 <b>وضعیت سیستم:</b> با کسب برآیند مثبت در این موقعیت، معیارهای ریسک ربات به حالت استاندارد بازنشانی شدند.
🛠️ <b>تنظیمات اعمال شده:</b>
  ✅ ضریب تصحیح اهرم: <code>1.0x</code> (اهرم استاندارد صرافی)
  ✅ آستانه حساسیت: <b>پویا (بازنشانی به حالت پیش‌فرض کاربر - ${this.sensitivity})</b>
  ✅ محدودیت حجم ورود (Position Size Limit): لغو شد (رعایت آستانه خام مدیریت سرمایه)
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه هوشمند اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
        `.trim());
      }
      return;
    }

    // LOSS: Trigger Core Self-Correction & Diagnostics Routine!
    this.consecutiveLosses += 1;
    
    // 1. Diagnose root causes
    let reasonShortEn = "";
    let reasonShortFa = "";
    let reasonDetailFa = "";
    
    const correlationGroup = this.corrMgr.getGroupDescription(order.symbol);

    if (this.btcChange > 0.03 || this.btcChange < -0.03) {
      reasonShortEn = "heavy_btc_drag";
      reasonShortFa = "ریزش جفت ارزها همسو با طوفان قیمتی همبستگی بیت‌کوین (BTC Correlation Drag)";
      reasonDetailFa = `بیت کوین نوسان نسبی شدیدی داشت (تغییرات: ${(this.btcChange * 100).toFixed(1)}٪). در چنین شرایطی واگرایی‌های کوین‌های فرعی لغو و حد ضرر فعال می‌گردد.`;
    } else if (order.daily_vol && order.daily_vol > 0.15) {
      reasonShortEn = "extreme_volatility_whipsaw";
      reasonShortFa = "نوسانات هانتینگ سنگین سایه شمع‌ها (High Volatility Whipsaw)";
      reasonDetailFa = `کوین ${order.symbol} دارای نوسانات روزانه بسیار زیاد (${(order.daily_vol * 100).toFixed(1)}٪) بود که باعث فشرده شدن حد ضرر به دلیل شدت اصلاح شد.`;
    } else if (order.imbalance && Math.abs(order.imbalance) > 0.25) {
      reasonShortEn = "order_book_spread_liquidation";
      reasonShortFa = "برداشت نقدینگی ناگهانی از اوردربوک صرافی (Orderbook Spread Slippage)";
      reasonDetailFa = `برقراری ناپایداری شدید در اوردربوک به نفع فروشندگان مخفی (عدم تطابق ارزش تا ${(order.imbalance * 100).toFixed(1)}٪) که منتهی به ورود اسلیپیج و هارد استاپ شد.`;
    } else {
      reasonShortEn = "support_breakout_reversal";
      reasonShortFa = "شکست کاذب سطح تقاضای خریداران SMC و تغییر در لایه جریان پول هوشمند";
      reasonDetailFa = `تغییر جهت پین بارها به سمت کانال نزولی و شکار حد ضررهای خریداران در کف معتبر SMC قبل از حرکت برگشتی.`;
    }

    // 2. Adaptive Parameter Self-Correction
    const oldSensitivity = this.adaptiveSensitivityOverride || (this.sensitivity === "auto_cortex" ? this.calculateCortexDynamicSensitivity() : this.sensitivity);
    let newSensitivity: "conservative" | "balanced" | "active" = "conservative";
    
    if (this.consecutiveLosses >= 2) {
      newSensitivity = "conservative"; // strict risk clamp
    } else if (oldSensitivity === "active") {
      newSensitivity = "balanced";
    } else {
      newSensitivity = "conservative";
    }
    this.adaptiveSensitivityOverride = newSensitivity;

    // Scale down leverage
    this.leverageMultiplier = Math.max(0.40, 1.0 - (this.consecutiveLosses * 0.15));

    // 🧠 Smart Risk-Reduction (replaces the old 4-hour hard quarantine):
    // the symbol & its correlation group remain fully scannable and tradeable,
    // but for the next 90 minutes their position size is reduced and the
    // win-probability bar is raised — both decaying smoothly back to normal.
    // Stronger reductions follow longer loss streaks.
    const riskWindow = 90 * 60 * 1000; // 90 minutes, linear decay back to normal
    const reductionStrength = Math.min(0.7, 0.3 + this.consecutiveLosses * 0.1); // how much smaller position sizes get at the start
    const sizeFactor = 1 - reductionStrength; // e.g. 0.5 = half-size at the start of the window
    const extraConfidence = Math.min(0.10, 0.03 + this.consecutiveLosses * 0.015); // up to +10% required win-probability at the start

    this._applyRiskReduction(order.symbol, riskWindow, sizeFactor, extraConfidence);
    if (correlationGroup) {
      this._applyRiskReduction(correlationGroup, riskWindow, sizeFactor, extraConfidence);
    }

    // Add log entry to diagnostics ledger
    const diagnosticLog = {
      id: `diag-${Date.now()}-${order.symbol}`,
      time: Date.now(),
      symbol: order.symbol,
      type: "loss_diagnostics",
      title: `عیب‌یابی خودکار موقعیت ${order.symbol}`,
      message: `موقعیت معاملاتی ${order.symbol} با زیان ${Math.abs(finalPnl).toFixed(2)}٪ بسته شد. دلیل شناسایی شده: ${reasonShortFa}. ${reasonDetailFa}`,
      actionTaken: `فعال‌سازی کاهش ریسک هوشمند و رو به کاهش (۹۰ دقیقه) برای ${order.symbol} و گروه ${correlationGroup || "انفرادی"}: حجم معاملات جدید این نماد از ${(sizeFactor * 100).toFixed(0)}٪ شروع و به‌تدریج به ۱۰۰٪ بازمی‌گردد، و حدنصاب اعتماد ورود موقتاً ${(extraConfidence * 100).toFixed(1)}٪ افزایش یافت. فشرده‌سازی آستانه حساسیت سیستم به سطح "${newSensitivity.toUpperCase()}" جهت جلوگیری از نویز کاذب. ضریب اهرم سراسری ربات نیز به میزان ${(this.leverageMultiplier * 100).toFixed(0)}٪ اندازه استاندارد تنظیم شد.`
    };
    this.diagnosticLogs.unshift(diagnosticLog);
    if (this.diagnosticLogs.length > 50) {
      this.diagnosticLogs = this.diagnosticLogs.slice(0, 50);
    }

    // 3. Inform Telegram with beautifully structured Persian content
    const msg = `
🚨 <b>تحلیل خودمراقبتی و عیب‌یابی خودکار کورتکس (Cortex Adaptive Diagnostics)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━
🔹 <b>جفت‌ارز زیان‌ده:</b> <code>${order.symbol}/USDT</code> (${order.action === "buy" ? "LONG 🟢" : "SHORT 🔴"})
📉 <b>درصد زیان نهایی:</b> <code>${finalPnl.toFixed(2)}%</code> ($${Math.abs(finalPnlUsd).toFixed(2)})
💔 <b>توالی زیان‌های اخیر:</b> <code>${this.consecutiveLosses} معامله منفی پیاپی</code>

🔍 <b>علت زیان ریشه‌یابی شده:</b>
  ├ <b>عنوان عیب:</b> ${reasonShortFa}
  └ <b>شرح فنی:</b> ${reasonDetailFa}

🛠️ <b>اقدامات اصلاحی اتوماسیون ربات (Applied Auto-Corrections):</b>
  ├ 🛡️ <b>کاهش ریسک هوشمند (نه توقف کامل):</b> نماد <b>${order.symbol}</b> و کوین‌های همبسته گروه <b>${correlationGroup || "عمومی"}</b> به مدت <code>۹۰ دقیقه</code> با حجم کاهش‌یافته (${(sizeFactor * 100).toFixed(0)}٪) و حدنصاب اعتماد بالاتر (+${(extraConfidence * 100).toFixed(1)}٪) معامله می‌شوند؛ این کاهش به‌تدریج و به‌صورت خطی به حالت عادی برمی‌گردد و سیگنال‌های فوق‌العاده قوی همچنان قابل اجرا هستند.
  ├ 📈 <b>فشرده‌سازی حساسیت:</b> ارتقای اتوماتیک سطح حساسیت موتور به <b>"${newSensitivity.toUpperCase()}"</b> برای رد شدن فقط خالص‌ترین سیگنال‌های واگرایی.
  ├ ⚖️ <b>کاهش ضربه ریسک سراسری (Leverage Cut):</b> اعمال ضریب تصحیح <code>${this.leverageMultiplier.toFixed(2)}x</code> بر روی اهرم‌ها و پوزیشن سایز کل ربات (پیشگیری از وقوع مارجین کال یا پمپاژ مجدد ضرر).
  └ 📊 <b>سیستم محافظت ضد خودتخریبی پیاپی:</b> کاهش خودکار و موقت حجم معاملات بعدی این نماد به مقدار ریسک کمتر تا بازگشت به حالت عادی.
━━━━━━━━━━━━━━━━━━━━━━━━━━
🐉 <b>سامانه خودمراقبتی کورتکس اشیر ۴.۰</b> | ${new Date().toLocaleTimeString("fa-IR")}
    `.trim();

    await this.reporter.send(msg);
    await this.saveState();
  }

  async start() {
    this.shouldBeRunning = true;
    if (this.isRunning) return;
    this.isRunning = true;
    
    // Non-blocking IIFE background loop for smooth server boot
    (async () => {
      if (!this.welcomeSent) {
        try {
          await this.reporter.sendWelcome();
          this.welcomeSent = true;
          await this.saveState();
        } catch (err) {
          console.error("Failed to send welcome message:", err);
        }
      }

      // Start high-frequency direct tracking loop for active positions simultaneously!
      this.runHighFrequencyLiveTracker().catch((err) => {
        console.error("Fatal in High Frequency Live Tracker background loop:", err);
      });

      // Start the weekly coin-rotation background scheduler (no-op unless coinRotationEnabled is true)
      this.runCoinRotationScheduler().catch((err) => {
        console.error("Fatal in Coin Rotation Scheduler background loop:", err);
      });

      while (this.isRunning) {
        try {
          await this.scan();
          if (!this.isRunning) break;
          const intervalMs = this.config.SCAN_INTERVAL * 1000;
          this.nextScanTime = Date.now() + intervalMs;
          
          const stepMs = 500;
          let elapsed = 0;
          while (elapsed < intervalMs && this.isRunning) {
            await new Promise((resolve) => setTimeout(resolve, stepMs));
            elapsed += stepMs;
          }
        } catch (e: any) {
          const errMsg = e?.message || String(e);
          this.lastError = `Unhandled Loop Error: ${errMsg}`;
          this._addLog(`Unhandled Loop Error: ${errMsg}`);
          if (!this.isRunning) break;
          this.nextScanTime = Date.now() + 60000;
          const stepMs = 500;
          let elapsed = 0;
          while (elapsed < 60000 && this.isRunning) {
            await new Promise((resolve) => setTimeout(resolve, stepMs));
            elapsed += stepMs;
          }
        }
      }
      this.nextScanTime = null;
    })().catch((err) => {
      this.lastError = `Scanner background loop fatal error: ${err?.message || err}`;
      console.error("Scanner background loop fatal error:", err);
    });
  }

  stop() {
    this.shouldBeRunning = false;
    this.isRunning = false;
    this.nextScanTime = null;
    this.currentProgress = "سامانه در حالت آماده‌باش.";
    this.welcomeSent = false;
    this.saveState().catch(console.error);
  }
}
