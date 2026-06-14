/**
 * Shared forward-return engine. Both analysis models (A: statement-driven, B: trade-driven) call
 * this one function so "return" is defined identically across the project. The full methodology is
 * in ./returns-spec.md — this file implements it; neither model may invent its own return math.
 *
 * This is correlation / event-study analysis, NOT a trading signal or financial advice. Callers
 * must label output accordingly.
 *
 * Summary of what it computes (see spec for the why): given a dated event referencing a ticker, the
 * ticker's forward ABNORMAL return vs the S&P 500 (market-adjusted, beta = 1) at 1d / 1w / 1m / 3m,
 * measured in TRADING-DAY offsets on the benchmark's own calendar, with a no-look-ahead entry rule
 * and explicit null+status on every kind of missing data (never fabricated).
 */

import { ols } from "./stats.js";

/** Horizons in trading-day offsets from the entry day (spec §2). */
export const HORIZONS = { "1d": 1, "1w": 5, "1m": 21, "3m": 63 } as const;
export type HorizonLabel = keyof typeof HORIZONS;

/** Estimation window (trading days before entry) for the optional α/β market model (spec §5 / R5). */
export const EST_WINDOW = { long: 150, short: 30 } as const;

/** Investable S&P 500 proxy used as the benchmark; its dates ARE the trading calendar (spec §2). */
export const BENCHMARK = "SPY";
/** Max prior trading days to look back when an exact bar is missing for a thin name (spec §7). */
export const GAP_TOLERANCE_DAYS = 3;
/** Below this sample size a rolled-up group is flagged low-confidence (spec §9). Used by the models. */
export const MIN_SAMPLE = 10;
/** Date (1–31) of the nth Sunday of a month (1-indexed month). */
function nthSundayOfMonth(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = Sunday
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/**
 * Is a date in U.S. Eastern daylight time? DST runs 2nd-Sunday-March → 1st-Sunday-November (MA7).
 * Day-granularity (the ≤1h edge at the 02:00 transition is immaterial to a 16:00 close cutoff).
 */
export function isUsEasternDst(dateOnly: string): boolean {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  return t >= Date.UTC(y, 2, nthSundayOfMonth(y, 3, 2)) && t < Date.UTC(y, 10, nthSundayOfMonth(y, 11, 1));
}

/** UTC hour of the 16:00-ET market close on a given date: 20:00 in EDT (summer), 21:00 in EST (winter). */
function marketCloseHourUtc(dateOnly: string): number {
  return isUsEasternDst(dateOnly) ? 20 : 21;
}

export type Direction = "buy" | "sell";
/** Which per-model entry policy to apply (spec §4). Trades enter same-day; statements enter after. */
export type EntryKind = "trade" | "statement";

export interface ComputeInput {
  ticker: string;
  /** ISO date (YYYY-MM-DD) or full ISO datetime — the statement timestamp or trade transaction date. */
  eventDate: string;
  entry: EntryKind;
  /** True if `eventDate` carries a meaningful time-of-day (statements); false → date-only. */
  eventHasIntradayTime: boolean;
  /** Trades only; statements omit (unsigned). Drives the sign of `signed_return` (spec §6). */
  direction?: Direction | null;
  /** Model flags a non-equity asset (option/bond/crypto/mutual fund) → unsupported_asset (spec §7). */
  unsupportedAsset?: boolean;
}

export type EventStatus = "ok" | "unresolved_ticker" | "unsupported_asset" | "no_entry_price";
export type HorizonStatus = "ok" | "insufficient_history" | "price_gap" | "delisted";

export interface HorizonResult {
  exit_date: string | null;
  exit_price: number | null;
  raw_return: number | null;
  benchmark_return: number | null;
  abnormal_return: number | null;
  signed_return: number | null;
  status: HorizonStatus;
}

export interface EventReturns {
  ticker: string;
  direction: Direction | null;
  entry_date: string | null;
  entry_price: number | null;
  status: EventStatus;
  horizons: Record<HorizonLabel, HorizonResult>;
  notes: string;
}

/** A symbol's daily adjusted-close series. `dates` is ascending and lists this symbol's trading days. */
export interface PriceSeries {
  dates: string[];
  closeByDate: Map<string, number>;
  /** Optional daily volume (for MA8 abnormal-volume); absent when the source carries no volume. */
  volumeByDate?: Map<string, number>;
}

/** Injected price access. The benchmark series doubles as the trading calendar (spec §2). */
export interface PriceAccess {
  benchmark: PriceSeries;
  /** null = ticker unresolved at the price source. */
  series(ticker: string): PriceSeries | null;
}

function emptyHorizons(): Record<HorizonLabel, HorizonResult> {
  const blank = (): HorizonResult => ({
    exit_date: null,
    exit_price: null,
    raw_return: null,
    benchmark_return: null,
    abnormal_return: null,
    signed_return: null,
    status: "insufficient_history",
  });
  return { "1d": blank(), "1w": blank(), "1m": blank(), "3m": blank() };
}

function shell(input: ComputeInput, status: EventStatus, notes = ""): EventReturns {
  return {
    ticker: input.ticker,
    direction: input.direction ?? null,
    entry_date: null,
    entry_price: null,
    status,
    horizons: emptyHorizons(),
    notes,
  };
}

/** Binary search: index of the first calendar date >= target ("on or after"). cal.length if none. */
function firstOnOrAfter(cal: string[], target: string): number {
  let lo = 0;
  let hi = cal.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cal[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Entry index t0 on the trading calendar per the per-model policy (spec §4) — the main
 * no-look-ahead guard. Returns -1 when the event falls outside the price history (before it begins,
 * or so recent that t0 isn't available yet) → caller maps to no_entry_price.
 */
function entryIndex(cal: string[], input: ComputeInput): number {
  const evDate = input.eventDate.slice(0, 10);
  if (evDate < cal[0]) return -1; // price history doesn't cover the event
  const idx = firstOnOrAfter(cal, evDate); // first trading day on/after the event date
  if (idx >= cal.length) return -1; // event after our last bar — can't enter

  if (input.entry === "trade") {
    // Transaction date if it's a trading day, else the next trading day.
    return idx;
  }

  // Statements: an outside observer can't act before the close that follows the statement.
  if (input.eventHasIntradayTime && cal[idx] === evDate) {
    // Statement on a trading day: did it land before that day's close (DST-aware, MA7)?
    const closeTs = `${evDate}T${String(marketCloseHourUtc(evDate)).padStart(2, "0")}:00:00Z`;
    return input.eventDate < closeTs ? idx : idx + 1;
  }
  if (cal[idx] === evDate) {
    // Date-only statement on a trading day → next trading day's close is the first actionable one.
    return idx + 1;
  }
  // Statement on a weekend/holiday → the next trading day's close already follows it.
  return idx;
}

/**
 * Price at a calendar index, falling back to the most recent prior trading day within tolerance for
 * a thin name with a missing bar (spec §7). Returns the bar used (date + price) or null.
 */
function priceNear(
  series: PriceSeries,
  cal: string[],
  calIdx: number,
  tol: number,
): { date: string; price: number } | null {
  for (let k = 0; k <= tol; k++) {
    const d = cal[calIdx - k];
    if (d === undefined) break;
    const px = series.closeByDate.get(d);
    if (px !== undefined) return { date: d, price: px };
  }
  return null;
}

export interface ComputeOptions {
  /** Use the α/β market model (spec §5 / R5) for the expected return instead of beta = 1. */
  marketModel?: boolean;
}

/** Estimate daily α/β by OLS of stock daily returns on benchmark daily returns over [t0-150, t0-30]. */
function estimateMarketModel(
  tseries: PriceSeries,
  bench: PriceSeries,
  cal: string[],
  t0idx: number,
): { alpha: number; beta: number } | null {
  const lo = Math.max(1, t0idx - EST_WINDOW.long);
  const hi = t0idx - EST_WINDOW.short;
  if (hi <= lo) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = lo; i <= hi; i++) {
    const s = tseries.closeByDate.get(cal[i]);
    const sp = tseries.closeByDate.get(cal[i - 1]);
    const m = bench.closeByDate.get(cal[i]);
    const mp = bench.closeByDate.get(cal[i - 1]);
    if (s == null || sp == null || m == null || mp == null) continue;
    ys.push(s / sp - 1);
    xs.push(m / mp - 1);
  }
  if (xs.length < 30) return null; // too few overlapping days to estimate a stable model
  return ols(xs, ys);
}

/**
 * Compute forward abnormal returns for one event. Pure given `prices`; the models call it per
 * event after loading prices via ./prices.buildPriceAccess. See ./returns-spec.md for full rules.
 * With `opts.marketModel`, the expected return uses estimated α/β (spec §5) rather than beta = 1.
 */
export function computeForwardReturns(
  input: ComputeInput,
  prices: PriceAccess,
  opts: ComputeOptions = {},
): EventReturns {
  if (input.unsupportedAsset) return shell(input, "unsupported_asset", "non-equity asset; not priced");

  const tseries = prices.series(input.ticker);
  if (!tseries || tseries.dates.length === 0) return shell(input, "unresolved_ticker");

  const cal = prices.benchmark.dates;
  const t0idx = entryIndex(cal, input);
  if (t0idx < 0) return shell(input, "no_entry_price", "event outside available price history");

  const entry = priceNear(tseries, cal, t0idx, GAP_TOLERANCE_DAYS);
  if (!entry) return shell(input, "no_entry_price", "ticker not priced at entry (not yet listed?)");

  const entryDate = cal[t0idx];
  const b0 = prices.benchmark.closeByDate.get(entryDate);
  // entryDate is a benchmark trading day by construction, so b0 is always present.
  if (b0 === undefined) return shell(input, "no_entry_price", "benchmark missing at entry");

  const direction = input.direction ?? null;
  const sign = direction === "sell" ? -1 : 1; // sell: dodging a drop is good (spec §6)
  const lastT = tseries.dates[tseries.dates.length - 1];

  // Expected-return model: beta = 1 by default; α/β market model when requested (falls back if the
  // estimation window is too sparse).
  let expected = (benchRet: number, _hDays: number) => benchRet;
  let mmNote = "";
  if (opts.marketModel) {
    const est = estimateMarketModel(tseries, prices.benchmark, cal, t0idx);
    if (est) {
      expected = (benchRet, hDays) => est.alpha * hDays + est.beta * benchRet;
      mmNote = `market-model α=${est.alpha.toFixed(5)} β=${est.beta.toFixed(2)}`;
    } else {
      mmNote = "market-model: insufficient estimation window → beta=1";
    }
  }

  const horizons = emptyHorizons();
  for (const label of Object.keys(HORIZONS) as HorizonLabel[]) {
    const hIdx = t0idx + HORIZONS[label];
    const h = horizons[label];
    if (hIdx >= cal.length) {
      h.status = "insufficient_history"; // calendar doesn't reach this horizon yet (event too recent)
      continue;
    }
    const exitDate = cal[hIdx];
    const bH = prices.benchmark.closeByDate.get(exitDate);
    if (bH === undefined) {
      h.status = "insufficient_history";
      continue;
    }
    const exit = priceNear(tseries, cal, hIdx, GAP_TOLERANCE_DAYS);
    if (!exit) {
      // Distinguish a delisting (ticker series ended before the window) from a mid-series gap.
      const windowStart = cal[Math.max(0, hIdx - GAP_TOLERANCE_DAYS)];
      h.status = lastT < windowStart ? "delisted" : "price_gap";
      continue;
    }
    const raw = exit.price / entry.price - 1;
    const bench = bH / b0 - 1;
    const abnormal = raw - expected(bench, HORIZONS[label]);
    h.exit_date = exit.date;
    h.exit_price = exit.price;
    h.raw_return = raw;
    h.benchmark_return = bench;
    h.abnormal_return = abnormal;
    h.signed_return = sign * abnormal;
    h.status = "ok";
  }

  const noteParts = [entry.date !== entryDate ? `entry price from ${entry.date} (gap-filled)` : "", mmNote].filter(Boolean);
  return {
    ticker: input.ticker,
    direction,
    entry_date: entryDate,
    entry_price: entry.price,
    status: "ok",
    horizons,
    notes: noteParts.join("; "),
  };
}

/**
 * Pre-event abnormal return ("run-up") over the `lookback` trading days BEFORE entry (R2): how much
 * the stock had already moved vs the market going into the event — the key reverse-causation check.
 * Returns null when the window isn't fully covered.
 */
export function preEventAbnormal(
  ticker: string,
  eventDate: string,
  prices: PriceAccess,
  lookback = HORIZONS["1m"],
): number | null {
  const tseries = prices.series(ticker);
  if (!tseries) return null;
  const cal = prices.benchmark.dates;
  const evDate = eventDate.slice(0, 10);
  if (evDate < cal[0]) return null;
  const t0idx = firstOnOrAfter(cal, evDate);
  const startIdx = t0idx - lookback;
  if (t0idx >= cal.length || startIdx < 0) return null;
  const p1 = priceNear(tseries, cal, t0idx, GAP_TOLERANCE_DAYS);
  const p0 = priceNear(tseries, cal, startIdx, GAP_TOLERANCE_DAYS);
  const b1 = prices.benchmark.closeByDate.get(cal[t0idx]);
  const b0 = prices.benchmark.closeByDate.get(cal[startIdx]);
  if (!p0 || !p1 || b0 == null || b1 == null) return null;
  return p1.price / p0.price - 1 - (b1 / b0 - 1);
}

/**
 * Abnormal trading volume on the event's trading day vs the trailing `lookback`-day average (MA8):
 * `volume(t) / mean(volume[t−lookback..t−1]) − 1` (0 = normal, +1 = double). null when the source
 * carries no volume or there's too little history. A corroborating "did the market notice?" signal.
 */
export function abnormalVolume(
  ticker: string,
  eventDate: string,
  prices: PriceAccess,
  lookback = HORIZONS["1m"],
): number | null {
  const tseries = prices.series(ticker);
  if (!tseries?.volumeByDate || tseries.volumeByDate.size === 0) return null;
  const cal = prices.benchmark.dates;
  const ev = eventDate.slice(0, 10);
  if (ev < cal[0]) return null;
  const idx = firstOnOrAfter(cal, ev);
  if (idx >= cal.length) return null;
  const vEvent = tseries.volumeByDate.get(cal[idx]);
  if (vEvent == null) return null;
  const prior: number[] = [];
  for (let k = 1; k <= lookback * 2 && prior.length < lookback; k++) {
    const d = cal[idx - k];
    if (d === undefined) break;
    const v = tseries.volumeByDate.get(d);
    if (v != null && v > 0) prior.push(v);
  }
  if (prior.length < 5) return null;
  const avg = prior.reduce((a, b) => a + b, 0) / prior.length;
  return avg > 0 ? vEvent / avg - 1 : null;
}
