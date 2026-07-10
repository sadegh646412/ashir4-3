/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { XTClient } from "./src/lib/ashir/xtClient";
import { TelegramReporter } from "./src/lib/ashir/telegramReporter";
import { TelegramBotHandler } from "./src/lib/ashir/telegramBot";
import { WaterfallScanner } from "./src/lib/ashir/scanner";
import { config as ashirConfig } from "./src/lib/ashir/config";
import { computeLedgerStats } from "./src/lib/ashir/ledgerStats";
import { runBacktest } from "./src/lib/ashir/backtest";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Standard emergency logger
process.on("uncaughtException", (err) => {
  const msg = `[${new Date().toISOString()}] UNCAUGHT EXCEPTION:\n${err?.stack || err}\n\n`;
  fs.appendFileSync(path.join(process.cwd(), "crash.log"), msg);
  console.error("UNCAUGHT EXCEPTION (NON-EXITING):", err);
});

process.on("unhandledRejection", (reason, promise) => {
  const msg = `[${new Date().toISOString()}] UNHANDLED REJECTION:\nReason: ${reason?.toString() || reason}\n\n`;
  fs.appendFileSync(path.join(process.cwd(), "crash.log"), msg);
  console.error("UNHANDLED REJECTION (NON-EXITING):", reason);
});

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

  const client = new XTClient(ashirConfig.XT_API_KEY);
  const reporter = new TelegramReporter(ashirConfig.TELEGRAM_TOKEN, ashirConfig.TELEGRAM_CHAT_ID);
  const scanner = new WaterfallScanner(client, reporter, ashirConfig);
  const telegramBot = new TelegramBotHandler(scanner, ashirConfig);
  telegramBot.start();

  app.use(express.json());

  // Bot Control API
  app.get("/api/bot/status", (req, res) => {
    res.json({
      // Single source of truth for closed-position performance stats — shared
      // with the Telegram bot's "سود/ضرر کل" button so the two can never disagree.
      ledgerStats: computeLedgerStats(scanner.closedOrders, ashirConfig.BASE_CAPITAL),
      baseCapital: ashirConfig.BASE_CAPITAL,
      isRunning: scanner.isRunning,
      count: scanner.count,
      btcChange: scanner.btcChange,
      orders: scanner.orders,
      closedOrders: scanner.closedOrders || [],
      lastScanTime: scanner.lastScanTime,
      nextScanTime: scanner.nextScanTime,
      scanInterval: ashirConfig.SCAN_INTERVAL,
      currentProgress: scanner.currentProgress,
      lastError: scanner.lastError,
      logs: scanner.scanLogs,
      apiKey: scanner.apiKey ? `${scanner.apiKey.slice(0, 4)}...${scanner.apiKey.slice(-4)}` : "",
      hasSecret: !!scanner.secretKey,
      tradingMode: scanner.tradingMode,
      realBalance: scanner.realBalance,
      demoBalance: scanner.rm.capital,
      demoTotalEquity: scanner.rm.capital + scanner.orders.reduce((acc, o) => acc + (o.pnl_usd || 0), 0),
      demoFreeBalance: scanner.rm.capital - scanner.orders.reduce((acc, o) => acc + (o.position_value || 0), 0),
      sensitivity: scanner.sensitivity,
      disable9Layers: scanner.disable9Layers,
      rejectedSignals: scanner.rejectedSignals,
      consecutiveLosses: scanner.consecutiveLosses,
      adaptiveSensitivityOverride: scanner.adaptiveSensitivityOverride,
      leverageMultiplier: scanner.leverageMultiplier,
      riskReductionMap: scanner.riskReductionMap,
      diagnosticLogs: scanner.diagnosticLogs,
      strategy: scanner.strategy,
      lastScanDurationMs: scanner.lastScanDurationMs,
      lastScanAssetCount: scanner.lastScanAssetCount,
      lastScanAssetsPerSec: scanner.lastScanAssetsPerSec,
      coinRotationEnabled: scanner.coinRotationEnabled,
      selectedCoins: scanner.selectedCoins,
      lastRotationAt: scanner.lastRotationAt,
      lastRotationReport: scanner.lastRotationReport,
      rotationInProgress: scanner.rotationInProgress,
    });
  });

  // Enable/disable trading-only-on-rotated-top-5 mode
  app.post("/api/bot/coin-rotation/toggle", async (req, res) => {
    try {
      const { enabled } = req.body;
      scanner.coinRotationEnabled = typeof enabled === "boolean" ? enabled : !scanner.coinRotationEnabled;
      await scanner.saveState();
      res.json({ success: true, coinRotationEnabled: scanner.coinRotationEnabled });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Manually trigger the coin-rotation screen+backtest process right now (takes a few minutes)
  app.post("/api/bot/coin-rotation/run", async (req, res) => {
    try {
      if (scanner.rotationInProgress) {
        return res.json({ success: false, error: "یک اجرای دیگر در حال انجام است." });
      }
      // اجرا در پس‌زمینه؛ بلافاصله پاسخ می‌دهیم چون این فرآیند چند دقیقه طول می‌کشد
      scanner.runCoinRotation(true).catch((e) => console.error("Manual coin rotation error:", e));
      res.json({ success: true, message: "فرآیند غربال و بک‌تست شروع شد؛ نتیجه در چند دقیقه در همین بخش و تلگرام نمایش داده می‌شود." });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Toggle 9 layers of validation
  app.post("/api/bot/toggle-9layers", async (req, res) => {
    try {
      const { disable9Layers } = req.body;
      if (typeof disable9Layers === "boolean") {
        scanner.disable9Layers = disable9Layers;
      } else {
        scanner.disable9Layers = !scanner.disable9Layers;
      }
      await scanner.saveState();
      res.json({
        success: true,
        message: scanner.disable9Layers 
          ? "تأییدیه‌های ۹ بعدی موقتاً غیرفعال شد. موقعیت‌های جدید فقط بر اساس چارت استراتژی SMC صادر می‌شوند." 
          : "تأییدیه‌های ۹ بعدی با موفقیت فعال‌ گردید.",
        disable9Layers: scanner.disable9Layers
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Save live XT exchange credentials & trading mode
  app.post("/api/bot/config", async (req, res) => {
    try {
      const { apiKey, secretKey, tradingMode, sensitivity, strategy } = req.body;
      
      if (typeof tradingMode === "string" && (tradingMode === "simulation" || tradingMode === "real")) {
        scanner.tradingMode = tradingMode;
      }

      if (typeof sensitivity === "string" && (sensitivity === "conservative" || sensitivity === "balanced" || sensitivity === "active" || sensitivity === "auto_cortex")) {
        scanner.sensitivity = sensitivity;
      }

      if (typeof strategy === "string") {
        if (strategy === "strict_elitescalp" || strategy === "active_goldenscalp" || strategy === "auto_cortex" || strategy === "auto") {
          scanner.strategy = strategy;
        } else {
          scanner.strategy = "auto";
        }
      }
      
      if (typeof apiKey === "string" && apiKey.trim() !== "") {
        scanner.apiKey = apiKey.trim();
      }
      if (typeof secretKey === "string" && secretKey.trim() !== "") {
        scanner.secretKey = secretKey.trim();
      }

      scanner.initCcxt();
      
      if (scanner.tradingMode === "real") {
        await scanner.updateRealBalance();
      }
      
      await scanner.saveState();
      
      res.json({ 
        success: true, 
        message: "تنظیمات صرافی و حالت معاملاتی ربات با موفقیت ذخیره شد.",
        realBalance: scanner.realBalance,
        sensitivity: scanner.sensitivity
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Manually close an active position immediately with a live market order on the exchange
  app.post("/api/bot/close-order", async (req, res) => {
    try {
      const { orderId } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: "شناسه سفارش ارسال نشده است." });
      }

      const order = scanner.orders.find(o => o.id === orderId);
      if (!order) {
        return res.status(404).json({ success: false, error: "موقعیت فعال معاملاتی یافت نشد." });
      }

      const currentPrice = order.current_price || order.entry_price;
      await scanner.closeActivePosition(order.id, currentPrice, "Manual Exit (خروج دستی منو)");
      res.json({ success: true, message: `پوزیشن ${order.symbol} با موفقیت در صرافی بسته شد.` });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Proxy endpoint for accurate historical klines (candles)
  app.get("/api/xt/kline", async (req, res) => {
    try {
      const { symbol, interval, limit } = req.query;
      const s = typeof symbol === "string" ? symbol : "BTC_USDT";
      const inter = typeof interval === "string" ? interval : "1h";
      const lim = typeof limit === "string" ? parseInt(limit, 10) : 100;

      const klines = await client.getKlines(s, inter, lim);
      if (klines) {
        res.json({ success: true, klines });
      } else {
        res.status(404).json({ success: false, error: "Failed to fetch klines" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // بک‌تست استراتژی TrendPulse روی داده‌ی تاریخی، پیش از اجرای زنده روی سرمایه‌ی واقعی
  app.get("/api/bot/backtest", async (req, res) => {
    try {
      const { symbol, interval, limit } = req.query;
      const s = typeof symbol === "string" ? symbol : "BTC_USDT";
      const inter = typeof interval === "string" ? interval : "5m";
      const lim = typeof limit === "string" ? Math.min(parseInt(limit, 10) || 1000, 1000) : 1000;

      const klines = await client.getKlines(s, inter, lim);
      if (!klines || klines.close.length < 80) {
        return res.status(404).json({ success: false, error: "داده‌ی تاریخی کافی برای این نماد/تایم‌فریم دریافت نشد." });
      }

      const result = runBacktest(s.toUpperCase(), klines);
      res.json({ success: true, result });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Proxy endpoint for direct, un-cached live market price with split-second accuracy
  app.get("/api/xt/ticker", async (req, res) => {
    try {
      const { symbol } = req.query;
      const s = typeof symbol === "string" ? symbol : "BTC_USDT";
      const price = await client.getLivePrice(s);
      if (price !== null) {
        res.json({ success: true, price });
      } else {
        res.status(404).json({ success: false, error: "Failed to fetch live price" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Proxy endpoint to fetch live trades of any selected coin
  app.get("/api/xt/trades", async (req, res) => {
    try {
      const { symbol, limit } = req.query;
      const s = typeof symbol === "string" ? symbol : "BTC";
      const lim = typeof limit === "string" ? parseInt(limit, 10) : 30;
      const symbolWithUsdt = s.toLowerCase().includes("_usdt") ? s.toLowerCase() : `${s.toLowerCase()}_usdt`;
      
      const response = await client.getRecentTrades(symbolWithUsdt, lim);
      if (response) {
        res.json({ success: true, trades: response });
      } else {
        res.status(404).json({ success: false, error: "Failed to fetch recent trades" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Proxy endpoint to fetch live orderbook of any selected coin
  app.get("/api/xt/orderbook", async (req, res) => {
    try {
      const { symbol, limit } = req.query;
      const s = typeof symbol === "string" ? symbol : "BTC";
      const lim = typeof limit === "string" ? parseInt(limit, 10) : 10;
      const symbolWithUsdt = s.toLowerCase().includes("_usdt") ? s.toLowerCase() : `${s.toLowerCase()}_usdt`;
      
      const response = await client.getOrderbook(symbolWithUsdt, lim);
      if (response) {
        res.json({ success: true, bids: response.bids, asks: response.asks });
      } else {
        res.status(404).json({ success: false, error: "Failed to fetch orderbook" });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Proxy endpoint to reset all test (simulated) trades
  app.post("/api/bot/reset-simulated-trades", async (req, res) => {
    try {
      const originalRealOrders = scanner.orders.filter(o => o.mode === "real");
      const removedSimCount = scanner.orders.filter(o => o.mode !== "real").length;
      const closedSimCount = scanner.closedOrders.length;

      scanner.orders = originalRealOrders; // keep real, remove simulated
      scanner.closedOrders = []; // clear all closed simulation orders

      // reset account stats for simulated tracking
      scanner.rm.capital = ashirConfig.BASE_CAPITAL;
      scanner.rm.peak = ashirConfig.BASE_CAPITAL;
      scanner.rm.totalTrades = 0;
      scanner.rm.winTrades = 0;

      await scanner.saveState();

      // notify telegram reporter
      await reporter.send(`🔄 <b>كل معاملات تستی ربات ریست شد</b>\n\nتعداد موقعیت‌های باز شبیه‌سازی لغو شده: <code>${removedSimCount}</code>\nتعداد معاملات بسته شده پاک شده: <code>${closedSimCount}</code>\n💰 موجودی حساب تستی به <code>$${ashirConfig.BASE_CAPITAL}</code> بازگردانده شد.`);

      res.json({
        success: true,
        message: "تمامی معاملات تستی و موجودی حساب شبیه‌سازی با موفقیت ریست شد و پیام به تلگرام ارسال گردید."
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Reset or remove specific symbols from the smart risk-reduction map
  app.post("/api/bot/reset-quarantine", async (req, res) => {
    try {
      const { symbol } = req.body;
      if (symbol) {
        // Find if symbol is stored as uppercase or exact match
        const cleanSymbol = String(symbol).toUpperCase().trim();
        let found = false;

        // Check for direct match or substring match
        for (const key of Object.keys(scanner.riskReductionMap)) {
          if (key.toUpperCase() === cleanSymbol || key.toUpperCase().includes(cleanSymbol)) {
            delete scanner.riskReductionMap[key];
            found = true;
          }
        }

        await scanner.saveState();
        res.json({
          success: true,
          message: found
            ? `محدودیت ریسک نماد ${cleanSymbol} با موفقیت برداشته شد.`
            : `نماد ${cleanSymbol} هم‌اکنون محدودیت ریسک فعالی ندارد.`
        });
      } else {
        const count = Object.keys(scanner.riskReductionMap).length;
        scanner.riskReductionMap = {};
        await scanner.saveState();
        res.json({
          success: true,
          message: `کلیه محدودیت‌های ریسک هوشمند (${count} مورد) با موفقیت برداشته شد.`
        });
      }
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  // Re-hydrate / Restore complete bot state from client backup
  app.post("/api/bot/restore-state", async (req, res) => {
    try {
      const state = req.body;
      if (!state || typeof state !== "object") {
        return res.status(400).json({ success: false, error: "ساختار دیتای ارسالی معتبر نیست." });
      }

      // Re-hydrate scanner memory fields if provided in request
      if (typeof state.count === "number" && state.count > scanner.count) scanner.count = state.count;
      if (Array.isArray(state.orders) && state.orders.length > 0) scanner.orders = state.orders;
      if (Array.isArray(state.closedOrders) && state.closedOrders.length > 0) {
        // Merge or replace closed orders to prevent history loss
        const existingIds = new Set(scanner.closedOrders.map(o => o.id));
        const newClosed = state.closedOrders.filter((o: any) => o && o.id && !existingIds.has(o.id));
        scanner.closedOrders = [...newClosed, ...scanner.closedOrders].slice(0, 100);
      }
      if (Array.isArray(state.scanLogs) && state.scanLogs.length > 0) {
        scanner.scanLogs = [...state.scanLogs, ...scanner.scanLogs].slice(0, 50);
      }
      if (typeof state.tradingMode === "string" && (state.tradingMode === "simulation" || state.tradingMode === "real")) {
        scanner.tradingMode = state.tradingMode;
      }
      if (typeof state.sensitivity === "string") scanner.sensitivity = state.sensitivity;
      if (typeof state.disable9Layers === "boolean") scanner.disable9Layers = state.disable9Layers;
      if (typeof state.strategy === "string") {
        if (state.strategy === "strict_elitescalp" || state.strategy === "active_goldenscalp" || state.strategy === "auto_cortex" || state.strategy === "auto") {
          scanner.strategy = state.strategy;
        } else {
          scanner.strategy = "auto";
        }
      }
      if (Array.isArray(state.rejectedSignals) && state.rejectedSignals.length > 0) {
        const existingTimes = new Set(scanner.rejectedSignals.map(s => s.time));
        const newRejected = state.rejectedSignals.filter((s: any) => s && s.time && !existingTimes.has(s.time));
        scanner.rejectedSignals = [...newRejected, ...scanner.rejectedSignals].slice(0, 100);
      }
      if (typeof state.demoCapital === "number") scanner.rm.capital = state.demoCapital;
      if (typeof state.totalTrades === "number" && state.totalTrades > scanner.rm.totalTrades) {
        scanner.rm.totalTrades = state.totalTrades;
      }
      if (typeof state.winTrades === "number" && state.winTrades > scanner.rm.winTrades) {
        scanner.rm.winTrades = state.winTrades;
      }
      if (typeof state.consecutiveLosses === "number") scanner.consecutiveLosses = state.consecutiveLosses;
      if (typeof state.leverageMultiplier === "number") scanner.leverageMultiplier = state.leverageMultiplier;
      if (Array.isArray(state.diagnosticLogs) && state.diagnosticLogs.length > 0) {
        scanner.diagnosticLogs = [...state.diagnosticLogs, ...scanner.diagnosticLogs].slice(0, 50);
      }

      // Mark as fully loaded so we can write this recovered state back to the disk
      scanner.isStateLoaded = true;
      await scanner.saveState();

      res.json({ success: true, message: "اطلاعات ربات با موفقیت بازیابی و همگام‌سازی شد." });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message || String(e) });
    }
  });

  app.post("/api/bot/start", (req, res) => {
    if (!scanner.isRunning) {
      scanner.start().catch((err) => {
        console.error("Scanner failed to start:", err);
      });
    }
    res.json({ success: true, message: "Scanner successfully initialized" });
  });

  // Auto-start scanner on boot
  scanner.start().catch((err) => console.error("Initial scanner start failed:", err));

  // 🛡️ Zero Downtime - Immortal Watchdog / Daemon Supervisor
  setInterval(() => {
    try {
      const now = Date.now();
      // If scanner is supposed to run, but is inactive, recover it
      if (scanner.shouldBeRunning && !scanner.isRunning) {
        console.warn("[WATCHDOG] Scanner active state mismatch detected! Auto-recovering scanner background loop...");
        scanner.start().catch((err) => {
          console.error("[WATCHDOG] Scanner recovery retry failed:", err);
        });
      }

      // If scanner is running but frozen (no succeeded scan cycle within 4 intervals + 2 mins)
      const maxAllowedUptimeWithoutScan = (ashirConfig.SCAN_INTERVAL * 4 * 1000) + 120000;
      if (scanner.shouldBeRunning && scanner.isRunning && scanner.lastScanTime) {
        if (now - scanner.lastScanTime > maxAllowedUptimeWithoutScan) {
          console.error(`[WATCHDOG] Hard hang detected! Scanner last succeeded at ${new Date(scanner.lastScanTime).toISOString()}. Forcing full state reset...`);
          scanner.stop();
          (scanner as any).isRunning = false;
          scanner.start().catch((err) => {
            console.error("[WATCHDOG] Restoring scanner run sequence after force reset failed:", err);
          });
        }
      }
    } catch (watchdogErr) {
      console.error("[WATCHDOG] Exception in supervisory watchdog loop:", watchdogErr);
    }
  }, 15000);

  app.post("/api/bot/stop", (req, res) => {
    scanner.stop();
    res.json({ success: true, message: "Scanner stopped" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
