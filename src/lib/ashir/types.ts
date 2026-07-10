/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Config {
  TELEGRAM_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  XT_API_KEY: string;
  XT_BASE_URL: string;
  BASE_CAPITAL: number;
  MAX_POSITIONS: number;
  POSITION_SIZE_MAX: number;
  MAX_DRAWDOWN: number;
  KELLY_FRACTION: number;
  SCAN_INTERVAL: number;
  TOP_TICKER_FILTER: number;
  ORDERBOOK_FILTER: number;
  DEEP_ANALYSIS: number;
  MIN_FINAL_SCORE: number;
  REQUEST_DELAY: number;

  // Adaptive Exit Engine (profit-lock trailing stop + smart early-loss exit)
  TRAILING_STOP_ENABLED: boolean;
  EARLY_LOSS_EXIT_ENABLED: boolean;
  EARLY_EXIT_MIN_LOSS_RATIO: number;
  EARLY_EXIT_MOMENTUM_Z: number;
  EARLY_EXIT_CONFIRM_TICKS: number;
}

export interface Ticker {
  symbol: string;
  clean: string;
  price: number;
  volume: number;
  change_24h: number;
}

export interface Klines {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  /** برچسب زمانی باز شدن هر کندل (میلی‌ثانیه) — اختیاری، برای صفحه‌بندی تاریخی استفاده می‌شود */
  time?: number[];
}

export interface OrderBook {
  bids: [number, number][];
  asks: [number, number][];
}

export interface VolMetrics {
  daily_vol: number;
  annualized_vol: number;
  regime: "low" | "normal" | "high" | "extreme" | "unknown";
  fitted: boolean;
}

export interface Signal {
  symbol: string;
  action: "buy" | "sell" | "stay_out";
  score: number;
  confidence: number;
  price: number;
  stop_loss: number;
  take_profit: number;
  take_profit_2: number;
  daily_vol: number;
  regime: string;
  vol_surge: boolean;
  vol_surge_msg: string;
  imbalance: number;
  iceberg: {
    iceberg_detected: boolean;
    direction: string;
    strength: number;
    message: string;
  };
  pain_point: {
    active: boolean;
    target_price: number;
    reason: string;
    distance_pct: number;
  };
  divergence: {
    divergence: boolean;
    type: string;
    strength: number;
    message: string;
  };
  dynamic_threshold: number;
  ml_weights: Record<string, number>;
  leverage?: number;
  correlation_group?: string;
  correlation_warning?: string;
  full_name?: string;
  market_link?: string;
  tradingview_link?: string;
  search_link?: string;
  sub_signals: Record<string, { score: number; signal?: string; reason?: string; message?: string }>;
  veto_reason?: string;
}

export interface Position {
  id: string;
  symbol: string;
  action: "buy" | "sell";
  quantity: number;
  entry_price: number;
  stop_loss: number;
  take_profit_1: number;
  take_profit_2: number;
  position_value: number;
  status: "filled" | "closed";
  score?: number;
  confidence?: number;
  daily_vol?: number;
  regime?: string;
  vol_surge?: boolean;
  vol_surge_msg?: string;
  imbalance?: number;
  iceberg?: any;
  pain_point?: any;
  divergence?: any;
  ml_weights?: any;
  dynamic_threshold?: number;
  sub_signals?: any;
  created_at?: number;
  current_price?: number;
  pnl_pct?: number;
  pnl_usd?: number;
  exit_price?: number;
  closed_at?: number;
  exit_reason?: string;
  tp1_hit?: boolean;
  mode?: "simulation" | "real";
  leverage?: number;
  initial_position_value?: number;
  initial_quantity?: number;
  tp1_pnl_usd?: number;
  tp1_pnl_pct?: number;
  tp1_exit_price?: number;
  tp2_pnl_usd?: number;
  tp2_pnl_pct?: number;
  // Adaptive exit engine telemetry (profit-lock trailing stop / smart early-loss exit)
  trailing_active?: boolean;
  trail_tier_pct?: number;
  original_stop_loss?: number;
}
