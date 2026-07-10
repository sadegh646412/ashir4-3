/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Position } from "./types";

/**
 * Cortex Ledger — single source of truth for closed-trade performance statistics.
 *
 * IMPORTANT: this function only ever looks at *closed* positions (`closedOrders`).
 * Open/active positions (even ones that already realized a partial 50% TP1 exit)
 * are intentionally excluded — their final outcome isn't known yet, so counting
 * them here would silently inflate win-rate / trade-count and could double-count
 * a single position once as "partial" and again later as "closed".
 *
 * Both the frontend dashboard (via /api/bot/status) and the Telegram bot reuse
 * this exact function, so the numbers shown in the app and in Telegram can never
 * drift apart or disagree.
 */

export interface LedgerTradeSummary {
  id: string;
  symbol: string;
  action: "buy" | "sell";
  pnl_usd: number;
  pnl_pct: number;
  closed_at?: number;
  exit_reason?: string;
}

export interface LedgerStats {
  totalClosed: number;
  wins: number;
  losses: number;
  winRate: number; // 0-100
  netUsd: number;
  netPct: number; // ROI %, relative to baseCapital
  grossProfitUsd: number;
  grossLossUsd: number; // stored as a positive magnitude
  avgWinUsd: number;
  avgLossUsd: number; // positive magnitude
  bestTrade: LedgerTradeSummary | null;
  worstTrade: LedgerTradeSummary | null;
  profitFactor: number | null; // null when undefined/infinite (no losses yet)
  profitFactorLabel: string;
  baseCapital: number;
}

function toSummary(o: Position): LedgerTradeSummary {
  return {
    id: o.id,
    symbol: o.symbol,
    action: o.action,
    pnl_usd: typeof o.pnl_usd === "number" && Number.isFinite(o.pnl_usd) ? o.pnl_usd : 0,
    pnl_pct: typeof o.pnl_pct === "number" && Number.isFinite(o.pnl_pct) ? o.pnl_pct : 0,
    closed_at: o.closed_at,
    exit_reason: o.exit_reason,
  };
}

export function computeLedgerStats(closedOrders: Position[], baseCapital: number): LedgerStats {
  const safeBase = baseCapital > 0 ? baseCapital : 1000;
  const orders = Array.isArray(closedOrders) ? closedOrders : [];

  let wins = 0;
  let losses = 0;
  let grossProfitUsd = 0;
  let grossLossUsd = 0;
  let best: LedgerTradeSummary | null = null;
  let worst: LedgerTradeSummary | null = null;

  for (const raw of orders) {
    const t = toSummary(raw);
    if (t.pnl_usd >= 0) {
      wins++;
      grossProfitUsd += t.pnl_usd;
    } else {
      losses++;
      grossLossUsd += Math.abs(t.pnl_usd);
    }
    if (!best || t.pnl_usd > best.pnl_usd) best = t;
    if (!worst || t.pnl_usd < worst.pnl_usd) worst = t;
  }

  const totalClosed = orders.length;
  const netUsd = grossProfitUsd - grossLossUsd;
  const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;
  const netPct = (netUsd / safeBase) * 100;

  let profitFactor: number | null;
  let profitFactorLabel: string;
  if (grossLossUsd === 0 && grossProfitUsd > 0) {
    profitFactor = null; // mathematically infinite (all wins, no losses yet)
    profitFactorLabel = "∞";
  } else if (grossLossUsd === 0 && grossProfitUsd === 0) {
    profitFactor = 0;
    profitFactorLabel = "0.00";
  } else {
    profitFactor = grossProfitUsd / grossLossUsd;
    profitFactorLabel = profitFactor.toFixed(2);
  }

  return {
    totalClosed,
    wins,
    losses,
    winRate,
    netUsd,
    netPct,
    grossProfitUsd,
    grossLossUsd,
    avgWinUsd: wins > 0 ? grossProfitUsd / wins : 0,
    avgLossUsd: losses > 0 ? grossLossUsd / losses : 0,
    bestTrade: best,
    worstTrade: worst,
    profitFactor,
    profitFactorLabel,
    baseCapital: safeBase,
  };
}
