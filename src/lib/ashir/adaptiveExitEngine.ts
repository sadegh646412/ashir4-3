/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Position } from "./types";

export interface TrailTier {
  profitPct: number;
  trailPct: number;
}

export interface AdaptiveExitConfig {
  trailingEnabled: boolean;
  trailTiers: TrailTier[];

  earlyExitEnabled: boolean;
  earlyExitMinLossRatio: number;
  momentumZThreshold: number;
  confirmTicks: number;
  windowSize: number;

  partialCutEnabled: boolean;
  partialCutLossRatio: number;
  partialCutFraction: number;

  baselineAtrPct: number;
}

export const DEFAULT_ADAPTIVE_EXIT_CONFIG: AdaptiveExitConfig = {
  trailingEnabled: true,
  trailTiers: [
    { profitPct: 0.008, trailPct: 0.006 },
    { profitPct: 0.015, trailPct: 0.004 },
    { profitPct: 0.030, trailPct: 0.0025 },
    { profitPct: 0.050, trailPct: 0.0015 },
  ],
  earlyExitEnabled: true,
  earlyExitMinLossRatio: 0.45,
  momentumZThreshold: 1.0,
  confirmTicks: 4,
  windowSize: 20,
  partialCutEnabled: true,
  partialCutLossRatio: 0.28,
  partialCutFraction: 0.4,
  baselineAtrPct: 0.01,
};

export interface MarketPressureContext {
  atrPct?: number;
  correlationStress?: number;
  signalInvalidated?: boolean;
  invalidationReason?: string;
}

interface OrderTrackState {
  prices: number[];
  peak: number;
  confirm: number;
  activeTierPct: number | null;
  partialCutDone: boolean;
}

export interface ExitDecision {
  newStopLoss?: number;
  trailTierChanged?: boolean;

  shouldEarlyExit?: boolean;
  earlyExitReason?: string;

  shouldPartialCut?: boolean;
  partialCutFraction?: number;
  partialCutReason?: string;

  debug?: { lossRatio?: number; momentumZ?: number; confirm?: number; effZThreshold?: number; effConfirmTicks?: number; volRatio?: number };
}

export class AdaptiveExitEngine {
  private state = new Map<string, OrderTrackState>();
  private cfg: AdaptiveExitConfig;

  constructor(cfg: Partial<AdaptiveExitConfig> = {}) {
    this.cfg = { ...DEFAULT_ADAPTIVE_EXIT_CONFIG, ...cfg };
  }

  register(order: Position) {
    if (!this.state.has(order.id)) {
      this.state.set(order.id, { prices: [order.entry_price], peak: order.entry_price, confirm: 0, activeTierPct: null, partialCutDone: false });
    }
  }

  clear(orderId: string) {
    this.state.delete(orderId);
  }

  evaluate(order: Position, livePrice: number, pnlPct: number, context: MarketPressureContext = {}): ExitDecision {
    const isBuy = order.action === "buy";
    let st = this.state.get(order.id);
    if (!st) {
      st = { prices: [order.entry_price], peak: order.entry_price, confirm: 0, activeTierPct: null, partialCutDone: false };
      this.state.set(order.id, st);
    }

    st.prices.push(livePrice);
    if (st.prices.length > this.cfg.windowSize) st.prices.shift();
    st.peak = isBuy ? Math.max(st.peak, livePrice) : Math.min(st.peak, livePrice);

    const decision: ExitDecision = {};
    const leverage = order.leverage || 1;
    const pricePct = pnlPct / 100 / leverage;

    if (context.signalInvalidated) {
      decision.shouldEarlyExit = true;
      decision.earlyExitReason = `ابطال سیگنال ورود${context.invalidationReason ? ` (${context.invalidationReason})` : ""} — مبنای فنی معامله دیگر برقرار نیست`;
      return decision;
    }

    if (this.cfg.trailingEnabled && pricePct > 0) {
      const tierPct = this.pickTier(pricePct);
      if (tierPct !== null) {
        const candidateStop = isBuy ? st.peak * (1 - tierPct) : st.peak * (1 + tierPct);
        const improves = isBuy ? candidateStop > order.stop_loss : candidateStop < order.stop_loss;
        if (improves) {
          decision.newStopLoss = candidateStop;
          decision.trailTierChanged = st.activeTierPct !== tierPct;
          st.activeTierPct = tierPct;
        }
      }
    }

    if (pricePct < 0 && st.prices.length >= 5) {
      const lossRatio = this.lossRatio(order, livePrice);

      const volRatio = context.atrPct && context.atrPct > 0 ? context.atrPct / this.cfg.baselineAtrPct : 1;
      const volFactor = Math.min(1.8, Math.max(0.6, volRatio));

      const stress = Math.min(1, Math.max(0, context.correlationStress ?? 0));
      const stressFactor = 1 - 0.35 * stress;

      const effZThreshold = this.cfg.momentumZThreshold * volFactor * stressFactor;
      const effConfirmTicks = Math.max(2, Math.round(this.cfg.confirmTicks * volFactor * stressFactor));
      const effMinLossRatio = Math.max(0.15, this.cfg.earlyExitMinLossRatio * stressFactor);

      if (this.cfg.partialCutEnabled && !st.partialCutDone && lossRatio >= this.cfg.partialCutLossRatio) {
        st.partialCutDone = true;
        decision.shouldPartialCut = true;
        decision.partialCutFraction = this.cfg.partialCutFraction;
        decision.partialCutReason = `کاهش حجم پله‌ای (ضرر ${(lossRatio * 100).toFixed(0)}٪ فاصله تا حد ضرر — کاهش ریسک بدون بستن کامل)`;
      }

      if (lossRatio >= effMinLossRatio) {
        const z = this.momentumZ(st.prices, isBuy);
        const priorPrices = st.prices.slice(0, -1);
        const extendingAgainstPosition = isBuy
          ? livePrice <= Math.min(...priorPrices)
          : livePrice >= Math.max(...priorPrices);

        if (z >= effZThreshold && extendingAgainstPosition) {
          st.confirm += 1;
        } else {
          st.confirm = Math.max(0, st.confirm - 1);
        }

        decision.debug = { lossRatio, momentumZ: z, confirm: st.confirm, effZThreshold, effConfirmTicks, volRatio };

        if (st.confirm >= effConfirmTicks) {
          const stressNote = stress > 0.5 ? " | فشار همبستگی گروهی بالا" : "";
          decision.shouldEarlyExit = true;
          decision.earlyExitReason = `خروج هوشمند زودهنگام (ادامه‌دار بودن روند ضرر تأیید شد، پیشرفت ${(lossRatio * 100).toFixed(0)}٪ تا حد ضرر${stressNote})`;
        }
      } else {
        st.confirm = 0;
      }
    } else if (pricePct >= 0) {
      st.confirm = 0;
    }

    return decision;
  }

  private pickTier(pricePct: number): number | null {
    let selected: number | null = null;
    for (const t of this.cfg.trailTiers) {
      if (pricePct >= t.profitPct) selected = t.trailPct;
    }
    return selected;
  }

  private lossRatio(order: Position, livePrice: number): number {
    const isBuy = order.action === "buy";
    const totalDist = isBuy ? order.entry_price - order.stop_loss : order.stop_loss - order.entry_price;
    if (totalDist <= 0) return 0;
    const covered = isBuy ? order.entry_price - livePrice : livePrice - order.entry_price;
    return Math.max(0, covered / totalDist);
  }

  private momentumZ(prices: number[], isBuy: boolean): number {
    if (prices.length < 4) return 0;
    const rets: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      rets.push((prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    const meanR = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - meanR) ** 2, 0) / rets.length;
    const sd = Math.sqrt(variance) || 1e-9;

    const recentSlice = rets.slice(-Math.max(3, Math.floor(rets.length / 2)));
    const recentMean = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;

    const direction = isBuy ? -1 : 1;
    return (direction * recentMean) / sd;
  }
}
