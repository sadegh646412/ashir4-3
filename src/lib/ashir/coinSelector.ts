/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { XTClient } from "./xtClient";
import { runBacktest, BacktestResult } from "./backtest";
import { Klines } from "./types";

/**
 * انتخابگر ارز برتر (Coin Selector / Rotation)
 * =============================================
 * این ماژول هفته‌ای یک‌بار (یا هر بازه‌ای که تنظیم شود) کل جفت‌ارزهای USDT
 * صرافی XT را از نظر نقدینگی یک‌ساله غربال می‌کند، سپس استراتژی TrendPulse را
 * روی کاندیداهای پرنقدینگی بک‌تست می‌کند و برترین‌ها را از نظر نرخ برد واقعی
 * (نه فرضی) انتخاب می‌کند.
 *
 * محدودیت صادقانه: صرافی XT هر درخواست kline را حداکثر با ۱۰۰۰ کندل و با
 * محدودیت نرخ ۱۰ درخواست بر ثانیه برای هر IP برمی‌گرداند. کشیدن یک سال کامل
 * کندل ۵ دقیقه‌ای (~۱۰۵۰۰۰ کندل) برای صدها نماد در یک اجرا عملاً با این
 * محدودیت‌ها ممکن نیست. به همین دلیل:
 *   ۱) غربال نقدینگی روی حجم واقعی یک‌ساله (کندل روزانه) انجام می‌شود.
 *   ۲) بک‌تست دقیق استراتژی (که ذاتاً روی کندل ۵ دقیقه کار می‌کند) روی یک
 *      پنجره‌ی معقول اخیر (پیش‌فرض ۴۵ روز) از داده‌ی ۵ دقیقه‌ای انجام می‌شود.
 * این محدودیت به‌صورت شفاف در نتیجه‌ی نهایی گزارش می‌شود.
 */

export interface CoinScreenResult {
  symbol: string;
  clean: string;
  avgDailyQuoteVolume: number;
  historyDays: number;
}

export interface CoinBacktestSummary {
  symbol: string;
  clean: string;
  winRate: number;
  profitFactor: number | null;
  profitFactorLabel: string;
  trades: number;
  avgRMultiple: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
}

export interface CoinRotationReport {
  generatedAt: number;
  universeSize: number;
  liquidityShortlistSize: number;
  backtestedCount: number;
  qualifiedCount: number;
  top5: CoinBacktestSummary[];
  allQualified: CoinBacktestSummary[];
  minTradesRequired: number;
  backtestWindowDays: number;
  warnings: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** واکشی صفحه‌بندی‌شده‌ی کندل‌های تاریخی با رعایت محدودیت نرخ صرافی (~۶ درخواست بر ثانیه، امن زیر سقف ۱۰) */
async function fetchHistoricalKlines(client: XTClient, symbol: string, interval: string, candlesNeeded: number, throttleMs = 170): Promise<Klines | null> {
  const perCallLimit = 1000;
  let endTime: number | undefined = undefined;
  const chunks: Klines[] = [];
  let collected = 0;
  let safetyCalls = 0;
  const maxCalls = Math.ceil(candlesNeeded / perCallLimit) + 2;

  while (collected < candlesNeeded && safetyCalls < maxCalls) {
    safetyCalls++;
    const result = await client.getKlines(symbol, interval, perCallLimit, endTime);
    if (!result || result.close.length === 0) break;

    chunks.unshift(result);
    collected += result.close.length;

    if (!result.time || result.time.length === 0) break; // بدون timestamp نمی‌توان صفحه‌بندی کرد؛ همین یک تکه کافیست
    endTime = result.time[0] - 1;

    await sleep(throttleMs);
  }

  if (chunks.length === 0) return null;

  const merged: Klines = { open: [], high: [], low: [], close: [], volume: [] };
  for (const c of chunks) {
    merged.open.push(...c.open);
    merged.high.push(...c.high);
    merged.low.push(...c.low);
    merged.close.push(...c.close);
    merged.volume.push(...c.volume);
  }
  return merged;
}

/** فاز ۱: غربال کل نمادهای USDT بر اساس میانگین حجم روزانه‌ی واقعی یک‌ساله */
export async function screenUniverseByYearlyVolume(
  client: XTClient,
  opts: { minHistoryDays?: number; topN?: number; throttleMs?: number } = {}
): Promise<{ shortlist: CoinScreenResult[]; universeSize: number; warnings: string[] }> {
  const minHistoryDays = opts.minHistoryDays ?? 250;
  const topN = opts.topN ?? 60;
  const throttleMs = opts.throttleMs ?? 130;
  const warnings: string[] = [];

  const allPairs = await client.getAllUsdtPairs(true);
  if (!allPairs.length) {
    warnings.push("دریافت لیست جفت‌ارزها از صرافی ناموفق بود.");
    return { shortlist: [], universeSize: 0, warnings };
  }

  const results: CoinScreenResult[] = [];
  for (const pair of allPairs) {
    try {
      const daily = await client.getKlines(pair.symbol, "1d", 365);
      await sleep(throttleMs);
      if (!daily || daily.close.length < minHistoryDays) continue;
      const avgDailyQuoteVolume = daily.volume.reduce((s, v) => s + v, 0) / daily.volume.length;
      if (avgDailyQuoteVolume <= 0) continue;
      results.push({ symbol: pair.symbol, clean: pair.clean, avgDailyQuoteVolume, historyDays: daily.close.length });
    } catch {
      // نماد مشکل‌دار را نادیده می‌گیریم و ادامه می‌دهیم
    }
  }

  results.sort((a, b) => b.avgDailyQuoteVolume - a.avgDailyQuoteVolume);
  return { shortlist: results.slice(0, topN), universeSize: allPairs.length, warnings };
}

/** فاز ۲: بک‌تست دقیق TrendPulse روی هر کاندیدا با داده‌ی ۵ دقیقه‌ای اخیر */
export async function backtestShortlist(
  client: XTClient,
  shortlist: CoinScreenResult[],
  opts: { windowDays?: number; throttleMs?: number; minTrades?: number } = {}
): Promise<{ qualified: CoinBacktestSummary[]; backtestedCount: number }> {
  const windowDays = opts.windowDays ?? 45;
  const throttleMs = opts.throttleMs ?? 170;
  const minTrades = opts.minTrades ?? 15;
  const candlesNeeded = windowDays * 288; // 288 کندل ۵ دقیقه‌ای در روز

  const qualified: CoinBacktestSummary[] = [];
  let backtestedCount = 0;

  for (const cand of shortlist) {
    try {
      const klines = await fetchHistoricalKlines(client, cand.symbol, "5m", candlesNeeded, throttleMs);
      if (!klines || klines.close.length < 100) continue;
      backtestedCount++;
      const result: BacktestResult = runBacktest(cand.clean, klines);
      if (result.trades.length >= minTrades) {
        qualified.push({
          symbol: cand.symbol,
          clean: cand.clean,
          winRate: result.winRate,
          profitFactor: result.profitFactor,
          profitFactorLabel: result.profitFactorLabel,
          trades: result.trades.length,
          avgRMultiple: result.avgRMultiple,
          totalReturnPct: result.totalReturnPct,
          maxDrawdownPct: result.maxDrawdownPct,
        });
      }
    } catch {
      // این نماد را رد کن و به بعدی برو
    }
  }

  return { qualified, backtestedCount };
}

/** ارکستراسیون کامل: غربال نقدینگی + بک‌تست + انتخاب ۵ ارز برتر */
export async function selectTopCoins(
  client: XTClient,
  opts: {
    topCount?: number;
    liquidityShortlistSize?: number;
    minHistoryDays?: number;
    backtestWindowDays?: number;
    minTrades?: number;
  } = {}
): Promise<CoinRotationReport> {
  const topCount = opts.topCount ?? 5;
  const liquidityShortlistSize = opts.liquidityShortlistSize ?? 60;
  const backtestWindowDays = opts.backtestWindowDays ?? 45;
  const minTrades = opts.minTrades ?? 15;

  const { shortlist, universeSize, warnings } = await screenUniverseByYearlyVolume(client, {
    minHistoryDays: opts.minHistoryDays ?? 250,
    topN: liquidityShortlistSize,
  });

  const { qualified, backtestedCount } = await backtestShortlist(client, shortlist, {
    windowDays: backtestWindowDays,
    minTrades,
  });

  qualified.sort((a, b) => {
    if (b.winRate !== a.winRate) return b.winRate - a.winRate;
    const pfA = a.profitFactor ?? 999;
    const pfB = b.profitFactor ?? 999;
    return pfB - pfA;
  });

  const allWarnings = [...warnings];
  if (qualified.length < topCount) {
    allWarnings.push(`تعداد نمادهای واجد شرایط (حداقل ${minTrades} معامله در بک‌تست) کمتر از ${topCount} است — فقط ${qualified.length} نماد معرفی می‌شود.`);
  }
  allWarnings.push(`به دلیل محدودیت نرخ درخواست صرافی XT، بک‌تست دقیق روی پنجره‌ی ${backtestWindowDays} روز اخیر (نه کل یک سال) انجام شده؛ غربال نقدینگی اولیه بر پایه‌ی حجم واقعی یک‌ساله بوده است.`);

  return {
    generatedAt: Date.now(),
    universeSize,
    liquidityShortlistSize: shortlist.length,
    backtestedCount,
    qualifiedCount: qualified.length,
    top5: qualified.slice(0, topCount),
    allQualified: qualified,
    minTradesRequired: minTrades,
    backtestWindowDays,
    warnings: allWarnings,
  };
}
