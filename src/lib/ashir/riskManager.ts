/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Position } from "./types";

export class RiskManager {
  public base: number;
  public kf: number;
  public maxp: number;
  public maxdd: number;
  public peak: number;
  public capital: number;
  public totalTrades = 0;
  public winTrades = 0;

  constructor(capital = 1000, kelly_frac = 0.25, max_pos_pct = 0.1, max_dd = 0.2) {
    this.base = capital;
    this.kf = kelly_frac;
    this.maxp = max_pos_pct;
    this.maxdd = max_dd;
    this.peak = capital;
    this.capital = capital;
  }

  calculatePosition(finalScore: number, price: number, volatility: number) {
    // 1. Dynamic historical winrate estimation (default to 56% if not enough history)
    const winRate = this.totalTrades >= 5 ? Math.max(0.35, Math.min(0.85, this.winTrades / this.totalTrades)) : 0.56;
    const avgRR = 1.6; // Average mathematical Risk-Reward target ratio

    // 2. Standard Kelly Criterion: f* = W - (1 - W) / R
    const rawKelly = winRate - (1 - winRate) / avgRR;

    // 3. Scale by kelly multiplier fraction (e.g. 0.25 for quarter-Kelly setup)
    let frac = Math.max(0.01, rawKelly * this.kf);

    // Signal scoring scale adjustment
    if (finalScore >= 0.82) {
      frac *= 1.25;
    } else if (finalScore < 0.65) {
      frac *= 0.60;
    }

    // Peak equity drawdown shield
    if (this.capital > this.peak) {
      this.peak = this.capital;
    }
    const currentDrawdown = this.peak > 0 ? (this.peak - this.capital) / this.peak : 0;
    if (currentDrawdown > this.maxdd * 0.5) {
      // Strongly suppress positioning under equity drag
      const dampeningFactor = Math.max(0.15, 1 - (currentDrawdown / this.maxdd));
      frac *= dampeningFactor;
    }

    // Bound firmly within risk bounds limit
    frac = Math.min(this.maxp, Math.max(0.015, frac));

    const size = this.capital * frac;
    return {
      position_size: Math.max(size, 10),
      quantity: price > 0 ? Math.max(size, 10) / price : 0,
      fraction: frac,
      capital: this.capital,
    };
  }

  canTrade(opens: number, max_pos = 8) {
    return this.capital > this.base * (1 - this.maxdd) && opens < max_pos;
  }
}
