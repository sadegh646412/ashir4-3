/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Config } from "./types";

export const config: Config = {
  // Telegram Info
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN || "8462634113:AAF5sBK187VXB3UakMT3cw5n5P0_EJWCSr8",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "2146248157",
  
  // XT Exchange Info
  XT_API_KEY: process.env.XT_API_KEY || "458efddf-5c6d-41dd-85de-5012ff4fa5fb",
  XT_BASE_URL: "https://sapi.xt.com",
  
  // Risk Management
  BASE_CAPITAL: 1000,
  MAX_POSITIONS: 5,
  POSITION_SIZE_MAX: 0.10,
  MAX_DRAWDOWN: 0.20,
  KELLY_FRACTION: 0.25,
  
  // Scanner Settings
  SCAN_INTERVAL: 20,
  TOP_TICKER_FILTER: 300,
  ORDERBOOK_FILTER: 80,
  DEEP_ANALYSIS: 40,
  MIN_FINAL_SCORE: 0.80,
  REQUEST_DELAY: 0.08,

  // Adaptive Exit Engine
  // TRAILING_STOP_ENABLED: once a trade is in profit, the stop-loss ratchets up (buy)
  // / down (sell) behind the best price reached, tightening as profit grows — locking
  // in gains instead of giving them back on a reversal.
  TRAILING_STOP_ENABLED: true,
  // EARLY_LOSS_EXIT_ENABLED: while a trade is underwater, watch short-term momentum;
  // if the loss is already a meaningful fraction of the distance to the hard stop AND
  // momentum keeps confirming further adverse movement, exit early instead of waiting
  // for the full stop-loss to be hit.
  EARLY_LOSS_EXIT_ENABLED: true,
  EARLY_EXIT_MIN_LOSS_RATIO: 0.45, // must already be 45%+ of the way to the stop-loss
  EARLY_EXIT_MOMENTUM_Z: 1.0,      // required strength of adverse momentum (z-score)
  EARLY_EXIT_CONFIRM_TICKS: 4,     // consecutive confirming ticks required (debounce)
};
