/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import axios from "axios";
import { format } from "date-fns";
import { Config } from "./types";
import { WaterfallScanner } from "./scanner";
import { computeLedgerStats } from "./ledgerStats";
import { ASHIR_MAIN_KEYBOARD } from "./telegramReporter";

/**
 * TelegramBotHandler — long-polls Telegram's getUpdates endpoint and answers the
 * "glass keyboard" (ReplyKeyboardMarkup) buttons shown under the chat input with
 * live, accurate data straight from the scanner (same numbers as the dashboard).
 *
 * Design goals (per user request: دقیق، بدون باگ، بدون هنگ کردن):
 *  - Never throws out of the polling loop: every iteration is wrapped in try/catch,
 *    so one bad network call or one malformed update can never kill/hang the bot.
 *  - Never blocks the scanner: this runs as its own independent async loop.
 *  - Uses the single shared `computeLedgerStats` helper — the exact same function
 *    used by /api/bot/status — so Telegram and the web dashboard can never disagree.
 */
export class TelegramBotHandler {
  private token: string;
  private chatId: string;
  private config: Config;
  private scanner: WaterfallScanner;
  private offset = 0;
  private running = false;
  private consecutiveErrors = 0;

  constructor(scanner: WaterfallScanner, config: Config) {
    this.scanner = scanner;
    this.config = config;
    this.token = config.TELEGRAM_TOKEN;
    this.chatId = String(config.TELEGRAM_CHAT_ID || "");
  }

  get enabled() {
    return !!(this.token && this.chatId);
  }

  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    // 🩹 Critical fix: if a webhook was EVER registered for this bot token (even
    // once, from an old deployment, a test curl command, or BotFather), Telegram
    // permanently blocks getUpdates() with a silent 409 "Conflict" error until the
    // webhook is explicitly deleted. sendMessage() keeps working fine either way —
    // which is exactly why signals/reports still arrive but button presses never
    // trigger a reply. We must clear it before the very first poll.
    this._clearWebhookThenPoll();
  }

  private async _clearWebhookThenPoll() {
    try {
      await axios.get(`https://api.telegram.org/bot${this.token}/deleteWebhook`, {
        params: { drop_pending_updates: false },
        timeout: 15000,
      });
    } catch (err: any) {
      console.error("[TelegramBot] deleteWebhook failed (continuing anyway):", err.message || err);
    }
    this._loop().catch((err) => {
      console.error("[TelegramBot] Polling loop crashed unexpectedly:", err);
      this.running = false;
    });
  }

  stop() {
    this.running = false;
  }

  private fmt(v: number) {
    return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  private formatPrice(v: number): string {
    if (!v) return "0.0000";
    if (v < 0.0001) return v.toFixed(8);
    if (v < 2) return v.toFixed(5);
    if (v < 10) return v.toFixed(4);
    return v.toFixed(2);
  }

  private async _loop() {
    while (this.running) {
      try {
        const res = await axios.get(`https://api.telegram.org/bot${this.token}/getUpdates`, {
          params: {
            offset: this.offset,
            timeout: 25,
            allowed_updates: JSON.stringify(["message"]),
          },
          timeout: 35000,
        });

        this.consecutiveErrors = 0;
        const updates = res.data?.result || [];
        for (const upd of updates) {
          // Always advance the offset even if a single update fails to process,
          // otherwise a single bad message would make the bot loop forever on it.
          this.offset = upd.update_id + 1;
          try {
            await this._handleUpdate(upd);
          } catch (handlerErr) {
            console.error("[TelegramBot] Failed to handle update:", handlerErr);
          }
        }
      } catch (err: any) {
        this.consecutiveErrors++;
        const backoff = Math.min(30000, 2000 * this.consecutiveErrors);
        const tgError = err?.response?.data?.description || err.message || err;
        console.error(`[TelegramBot] Poll error (retrying in ${backoff}ms): ${tgError}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  private async _handleUpdate(upd: any) {
    const msg = upd.message;
    if (!msg || typeof msg.text !== "string") return;

    const chatId = String(msg.chat?.id ?? "");
    // Only ever respond in the configured chat — never leak bot data to strangers
    // who happen to discover the bot's username.
    if (this.chatId && chatId !== this.chatId) return;

    const text = msg.text.trim();
    await this._route(chatId, text);
  }

  private async _reply(chatId: string, text: string) {
    try {
      const resp = await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: chatId,
          text: text.slice(0, 4000),
          parse_mode: "HTML",
          reply_markup: ASHIR_MAIN_KEYBOARD,
        },
        { timeout: 15000 }
      );
      const messageId = resp?.data?.result?.message_id;
      if (messageId) {
        this._scheduleDelete(chatId, messageId, 60000);
      }
    } catch (e: any) {
      console.error("[TelegramBot] Failed to send reply:", e.message || e);
    }
  }

  /** حذف خودکار پاسخ‌های کیبورد شیشه‌ای پس از ۱ دقیقه، تا چت شلوغ نشود */
  private _scheduleDelete(chatId: string, messageId: number, delayMs: number) {
    setTimeout(async () => {
      try {
        await axios.post(`https://api.telegram.org/bot${this.token}/deleteMessage`, {
          chat_id: chatId,
          message_id: messageId,
        }, { timeout: 15000 });
      } catch {
        // پیام از قبل حذف شده یا بیش از ۴۸ ساعت گذشته — نادیده می‌گیریم
      }
    }, delayMs);
  }

  private async _route(chatId: string, text: string) {
    const s = this.scanner;

    if (text === "/start" || text === "/menu") {
      await this._reply(chatId, "🔘 <b>منوی اصلی اشیر ۴.۰</b>\n\nیکی از دکمه‌های پایین را انتخاب کن:");
      return;
    }

    if (text.includes("وضعیت کلی")) {
      await this._reply(chatId, this._buildOverallStatus());
      return;
    }
    if (text.includes("پوزیشن‌های باز") || text.includes("پوزیشن های باز")) {
      await this._reply(chatId, this._buildOpenPositions());
      return;
    }
    if (text.includes("آخرین معاملات")) {
      await this._reply(chatId, this._buildLastTrades());
      return;
    }
    if (text.includes("سود/ضرر") || text.includes("سود / ضرر")) {
      await this._reply(chatId, this._buildProfitLossSummary());
      return;
    }
    if (text.includes("ریسک و قفل سود") || text.includes("ریسک")) {
      await this._reply(chatId, this._buildRiskAndTrailing());
      return;
    }
    if (text.includes("چرا معامله باز نشد")) {
      await this._reply(chatId, this._buildRejectedSignals());
      return;
    }
    if (text.includes("گزارش تحلیل عملکرد") || text.includes("تحلیل عملکرد")) {
      await this._reply(chatId, this._buildPerformanceReport());
      return;
    }
    if (text.includes("۵ ارز برتر") || text.includes("ارزهای برتر")) {
      await this._reply(chatId, this._buildTopCoins());
      return;
    }

    // Unknown text: gently nudge back to the menu instead of staying silent
    await this._reply(chatId, "متوجه نشدم 🤔 لطفاً از دکمه‌های شیشه‌ای پایین صفحه استفاده کن.");
  }

  // ─── 📊 وضعیت کلی ──────────────────────────────────────────────
  private _buildOverallStatus(): string {
    const s = this.scanner;
    const activeEmoji = s.isRunning ? "🟢" : "🔴";
    const modeText = s.tradingMode === "real" ? "واقعی (Real)" : "شبیه‌سازی (Demo)";
    const balance = s.tradingMode === "real" ? s.realBalance : s.rm.capital;
    const openCount = s.orders.length;
    const committed = s.orders.reduce((sum, o) => sum + (o.position_value || 0), 0);
    const stats = computeLedgerStats(s.closedOrders, this.config.BASE_CAPITAL);

    return `
📊 <b>وضعیت کلی ربات</b>
━━━━━━━━━━━━━━━━━━
اسکنر فعال است ${activeEmoji}
🏦 <b>حالت معاملاتی:</b> ${modeText}
💰 <b>موجودی/دارایی:</b> $${this.fmt(balance)}
📈 <b>پوزیشن‌های باز:</b> ${openCount}
💎 <b>درگیری سرمایه:</b> $${this.fmt(committed)}
🎯 <b>کل معاملات:</b> ${stats.totalClosed} | برد: ${stats.wins} (${stats.winRate.toFixed(1)}٪)
━━━━━━━━━━━━━━━━━━
🐉 اشیر ۴.۰ | ${format(new Date(), "HH:mm:ss")}
`.trim();
  }

  // ─── 📈 پوزیشن‌های باز ─────────────────────────────────────────
  private _buildOpenPositions(): string {
    const s = this.scanner;
    if (!s.orders || s.orders.length === 0) {
      return "📈 <b>پوزیشن‌های باز</b>\n━━━━━━━━━━━━━━━━━━\nهیچ معامله باز فعالی وجود ندارد.";
    }
    let out = `📈 <b>پوزیشن‌های باز (${s.orders.length})</b>\n━━━━━━━━━━━━━━━━━━\n`;
    for (const o of s.orders) {
      const pnlPct = typeof o.pnl_pct === "number" ? o.pnl_pct : 0;
      const pnlUsd = typeof o.pnl_usd === "number" ? o.pnl_usd : 0;
      const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
      const dirText = o.action === "buy" ? "LONG" : "SHORT";
      out += `${emoji} <b>${o.symbol}</b> (${dirText}${o.tp1_hit ? " | TP1 ✅" : ""})\n`;
      out += `   ورود: $${this.formatPrice(o.entry_price)} | فعلی: $${this.formatPrice(o.current_price || o.entry_price)}\n`;
      out += `   سود/ضرر: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}٪ ($${this.fmt(pnlUsd)})\n\n`;
    }
    return out.trim();
  }

  // ─── 🗂 آخرین معاملات ──────────────────────────────────────────
  private _buildLastTrades(): string {
    const s = this.scanner;
    const recent = (s.closedOrders || []).slice(0, 8);
    if (recent.length === 0) {
      return "🗂 <b>آخرین معاملات</b>\n━━━━━━━━━━━━━━━━━━\nهنوز هیچ معامله‌ای بسته نشده است.";
    }
    let out = `🗂 <b>${recent.length} معامله آخر بسته‌شده</b>\n━━━━━━━━━━━━━━━━━━\n`;
    for (const o of recent) {
      const pnlPct = typeof o.pnl_pct === "number" ? o.pnl_pct : 0;
      const pnlUsd = typeof o.pnl_usd === "number" ? o.pnl_usd : 0;
      const emoji = pnlUsd >= 0 ? "🟢" : "🔴";
      out += `${emoji} <b>${o.symbol}:</b> ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}٪ ($${pnlUsd >= 0 ? "+" : ""}${this.fmt(pnlUsd)}) — ${o.exit_reason || "نامشخص"}\n`;
    }
    return out.trim();
  }

  // ─── 💰 سود/ضرر کل ─────────────────────────────────────────────
  private _buildProfitLossSummary(): string {
    const s = this.scanner;
    const stats = computeLedgerStats(s.closedOrders, this.config.BASE_CAPITAL);
    const isNet = stats.netUsd >= 0;

    let out = `💰 <b>سود/ضرر کل (Ledger)</b>\n━━━━━━━━━━━━━━━━━━\n`;
    out += `✅ <b>موفقیت معاملات (Win Rate):</b> ${stats.winRate.toFixed(1)}٪ (${stats.wins} سود / ${stats.losses} ضرر از ${stats.totalClosed} معامله بسته‌شده)\n`;
    out += `${isNet ? "🟢" : "🔴"} <b>عایدی خالص کل:</b> ${isNet ? "+" : ""}$${this.fmt(stats.netUsd)}\n`;
    out += `📈 <b>بازده تجمعی (ROI):</b> ${isNet ? "+" : ""}${stats.netPct.toFixed(2)}٪ (نسبت به سرمایه اولیه $${this.fmt(stats.baseCapital)})\n`;
    out += `⚖️ <b>فاکتور سود (Profit Factor):</b> ${stats.profitFactorLabel}\n`;
    if (stats.bestTrade) {
      out += `🏆 <b>بهترین معامله:</b> ${stats.bestTrade.symbol}: +$${stats.bestTrade.pnl_usd.toFixed(1)} (+${stats.bestTrade.pnl_pct.toFixed(1)}٪)\n`;
    }
    if (stats.worstTrade && stats.worstTrade.pnl_usd < 0) {
      out += `📉 <b>بدترین معامله:</b> ${stats.worstTrade.symbol}: $${stats.worstTrade.pnl_usd.toFixed(1)} (${stats.worstTrade.pnl_pct.toFixed(1)}٪)\n`;
    }
    out += `💵 <b>میانگین سود / ضرر:</b> +$${stats.avgWinUsd.toFixed(1)} / -$${stats.avgLossUsd.toFixed(1)}`;
    return out.trim();
  }

  // ─── 🛡️ ریسک و قفل سود ────────────────────────────────────────
  private _buildRiskAndTrailing(): string {
    const s = this.scanner;
    const cfg = this.config;
    const peak = s.rm.peak || cfg.BASE_CAPITAL;
    const capital = s.rm.capital;
    const drawdownPct = peak > 0 ? Math.max(0, (peak - capital) / peak) * 100 : 0;
    const maxDrawdownPct = cfg.MAX_DRAWDOWN * 100;

    let out = `🛡️ <b>ریسک و قفل سود</b>\n━━━━━━━━━━━━━━━━━━\n`;
    out += `📉 <b>افت سرمایه فعلی:</b> ${drawdownPct.toFixed(2)}٪ (سقف مجاز: ${maxDrawdownPct.toFixed(0)}٪)\n`;
    out += `🔻 <b>باخت‌های متوالی:</b> ${s.consecutiveLosses}\n`;
    out += `⚡ <b>ضریب اهرم فعلی:</b> ${s.leverageMultiplier.toFixed(2)}x\n`;
    out += `🧭 <b>حساسیت تطبیقی:</b> ${s.adaptiveSensitivityOverride || "خودکار (Auto)"}\n`;
    out += `🔒 <b>قفل سود متحرک (Trailing Stop):</b> ${cfg.TRAILING_STOP_ENABLED ? "فعال ✅" : "غیرفعال ❌"}\n`;
    out += `🧠 <b>خروج هوشمند زودهنگام:</b> ${cfg.EARLY_LOSS_EXIT_ENABLED ? "فعال ✅" : "غیرفعال ❌"}\n`;

    const riskEntries = Object.entries(s.riskReductionMap || {});
    if (riskEntries.length > 0) {
      out += `\n⚠️ <b>نمادهای تحت محدودیت ریسک هوشمند (${riskEntries.length}):</b>\n`;
      for (const [symbol, info] of riskEntries.slice(0, 8)) {
        const remainMin = Math.max(0, Math.round((info.until - Date.now()) / 60000));
        out += `   • ${symbol}: ظرفیت ${(info.sizeFactor * 100).toFixed(0)}٪ | ${remainMin} دقیقه باقی‌مانده\n`;
      }
    } else {
      out += `\n✅ در حال حاضر هیچ نمادی تحت محدودیت ریسک نیست.`;
    }
    return out.trim();
  }

  // ─── 🔍 چرا معامله باز نشد؟ ────────────────────────────────────
  private _buildRejectedSignals(): string {
    const s = this.scanner;
    const recent = (s.rejectedSignals || []).slice(0, 8);
    if (recent.length === 0) {
      return "🔍 <b>چرا معامله باز نشد؟</b>\n━━━━━━━━━━━━━━━━━━\nهنوز هیچ سیگنالی رد نشده است (یا اطلاعاتی ثبت نشده).";
    }
    let out = `🔍 <b>آخرین سیگنال‌های رد شده (${recent.length})</b>\n━━━━━━━━━━━━━━━━━━\n`;
    for (const r of recent) {
      const t = r.time ? format(new Date(r.time), "HH:mm:ss") : "-";
      out += `❌ <b>${r.symbol}</b> (${r.action === "buy" ? "خرید" : "فروش"}) — امتیاز ${r.score.toFixed(2)} / آستانه ${r.threshold.toFixed(2)}\n   📝 ${r.reason} | ⏰ ${t}\n`;
    }
    return out.trim();
  }

  // ─── 🧾 گزارش تحلیل عملکرد ─────────────────────────────────────
  private _buildPerformanceReport(): string {
    const s = this.scanner;
    const logs = (s.diagnosticLogs || []).slice(0, 8);
    const stats = computeLedgerStats(s.closedOrders, this.config.BASE_CAPITAL);

    let out = `🧾 <b>گزارش تحلیل عملکرد</b>\n━━━━━━━━━━━━━━━━━━\n`;
    out += `📌 <b>راهبرد فعال:</b> ${s.strategy}\n`;
    out += `📌 <b>حساسیت فعال:</b> ${s.sensitivity}\n`;
    out += `🎯 <b>نرخ برد کلی:</b> ${stats.winRate.toFixed(1)}٪ از ${stats.totalClosed} معامله\n\n`;

    if (logs.length === 0) {
      out += "هنوز هیچ رویداد خودتشخیصی/تطبیقی ثبت نشده است.";
    } else {
      out += `🧠 <b>آخرین رویدادهای خودتطبیقی سیستم (${logs.length}):</b>\n`;
      for (const l of logs) {
        const t = l.time ? format(new Date(l.time), "HH:mm:ss") : "-";
        out += `• <b>${l.symbol}</b> [${l.type}] ${l.title} — ${l.actionTaken} | ⏰ ${t}\n`;
      }
    }
    return out.trim();
  }

  // ─── 🏆 ۵ ارز برتر فعلی (چرخش هفتگی) ───────────────────────────
  private _buildTopCoins(): string {
    const s = this.scanner;
    if (!s.coinRotationEnabled) {
      return "🏆 <b>۵ ارز برتر فعلی</b>\n━━━━━━━━━━━━━━━━━━\nحالت «چرخش ۵ ارز برتر» فعال نیست، پس ربات روی کل بازار معامله می‌کند، نه یک لیست ثابت.";
    }
    if (!s.selectedCoins || s.selectedCoins.length === 0) {
      return "🏆 <b>۵ ارز برتر فعلی</b>\n━━━━━━━━━━━━━━━━━━\nهنوز هیچ چرخشی انجام نشده — نتیجه پس از اولین بررسی هفتگی (یا اجرای دستی) اینجا نمایش داده می‌شود.";
    }
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const lastRun = s.lastRotationAt ? format(new Date(s.lastRotationAt), "yyyy/MM/dd HH:mm") : "-";
    let out = `🏆 <b>۵ ارز برتر فعلی (بر اساس آخرین بک‌تست)</b>\n━━━━━━━━━━━━━━━━━━\n🕒 آخرین بررسی: ${lastRun}\n\n`;
    s.selectedCoins.forEach((c, idx) => {
      out += `${medals[idx] || "🔹"} <b>${c.clean}</b> — نرخ برد ${c.winRate.toFixed(1)}٪ | فاکتور سود ${c.profitFactorLabel} | ${c.trades} معامله\n`;
    });
    out += `\n📌 معاملات زنده تا چرخش بعدی فقط روی همین نمادهاست.`;
    return out.trim();
  }
}
