import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedBars, setSymbolCoverage, symbolCoverage, upsertBars, type PriceBar } from "./db.js";
import { BENCHMARK, type PriceAccess, type PriceSeries } from "./returns.js";

/**
 * Price layer for the analysis models. Pluggable provider (same spirit as the OCR providers) behind
 * a local cache: a symbol is fetched from the source at most once, then served from `price_bars`.
 *
 * This is the project's ONE third-party data dependency — no official/free U.S. gov source publishes
 * market prices, so a forward-return study has to cross that line somewhere. It's isolated here and
 * clearly labelled.
 *
 * Sources (pick with RESEARCH_PRICE_PROVIDER):
 *  - 'csv'   (DEFAULT) — load daily adjusted close from per-symbol CSV files in RESEARCH_PRICE_DIR
 *            (default server/data/prices/, one file `SYMBOL.csv` per ticker incl. the benchmark
 *            `SPY.csv`). No live dependency: you supply the data (a broker/Yahoo/Stooq/Tiingo export,
 *            or any feed) and it's cached + reproducible. CSV format: a header with a `Date` column
 *            and an `Adj Close` (preferred) or `Close` column; `#`-prefixed lines are ignored.
 *  - 'yahoo' — Yahoo Finance chart endpoint, keyless, split+dividend-adjusted. Works for one-offs
 *            but throttles hard per-IP (429) on a multi-ticker backfill — kept as a fallback only.
 *
 * (Stooq was the original target but added an API-key wall, so it no longer fits "keyless".) The
 * provider interface lets a keyed source — Tiingo, a paid Stooq key — drop in without touching the
 * engine or the models.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Where per-symbol CSVs live for the 'csv' provider. You drop real exports here; gitignored. */
const DEFAULT_PRICE_DIR = process.env.RESEARCH_PRICE_DIR ?? resolve(__dirname, "../../../data/prices");

/** Earliest bar we backfill. Events before this resolve to no_entry_price (we lack prices there). */
const BACKFILL_START = process.env.RESEARCH_PRICE_START ?? "2014-01-01";
/** Polite delay between *live* fetches (cache hits never wait). */
const FETCH_SPACING_MS = Number(process.env.RESEARCH_PRICE_SPACING_MS ?? 400);
/** Yahoo rejects non-browser User-Agents, so a realistic one is required (override via env if needed). */
const USER_AGENT =
  process.env.RESEARCH_PRICE_UA ??
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export interface PriceSeriesProvider {
  readonly name: string;
  /** Daily adjusted-close bars for `ticker` over [fromIso, toIso], ascending. [] = no data found. */
  fetchDaily(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]>;
}

/** Map a plain ticker to Yahoo's symbol. Benchmark + class shares (BRK.B → BRK-B) handled. */
function yahooSymbol(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  if (t === BENCHMARK) return "SPY"; // investable S&P 500 proxy (the spec's default benchmark)
  if (t === "^SPX" || t === "^GSPC") return "^GSPC";
  return t.replace(/\./g, "-");
}

const epoch = (iso: string, endOfDay = false) =>
  Math.floor(Date.parse(`${iso}T${endOfDay ? "23:59:59" : "00:00:00"}Z`) / 1000);

class PriceRateLimitError extends Error {}

export const yahooProvider: PriceSeriesProvider = {
  name: "yahoo",
  async fetchDaily(ticker, fromIso, toIso) {
    const sym = yahooSymbol(ticker);
    const p1 = epoch(fromIso);
    const p2 = epoch(toIso, true);
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
      `?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplit`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 429) throw new PriceRateLimitError(`yahoo rate-limited fetching ${sym}`);
    if (res.status === 404) return []; // unknown symbol
    if (!res.ok) throw new Error(`yahoo HTTP ${res.status} for ${sym}`);

    const json = (await res.json()) as YahooChart;
    if (json.chart?.error) {
      // "Not Found"/"No data found" → unresolved; anything else is unexpected → surface it.
      if (/not found|no data|no timestamps/i.test(json.chart.error.description ?? "")) return [];
      throw new Error(`yahoo error for ${sym}: ${json.chart.error.description ?? json.chart.error.code}`);
    }
    const r = json.chart?.result?.[0];
    const ts = r?.timestamp;
    const adj = r?.indicators?.adjclose?.[0]?.adjclose;
    const close = r?.indicators?.quote?.[0]?.close;
    const volume = r?.indicators?.quote?.[0]?.volume;
    if (!r || !ts) return [];
    const px = adj ?? close; // adjusted preferred; fall back to raw close if Yahoo omits adjclose
    if (!px) return [];

    // De-dupe by date (keep last) and sort ascending — defensive; Yahoo is normally clean.
    const byDate = new Map<string, PriceBar>();
    for (let i = 0; i < ts.length; i++) {
      const v = px[i];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      const vol = volume?.[i];
      byDate.set(date, { date, close: v, volume: typeof vol === "number" && vol > 0 ? vol : null });
    }
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  },
};

interface YahooChart {
  chart?: {
    error?: { code?: string; description?: string } | null;
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        adjclose?: Array<{ adjclose?: (number | null)[] }>;
        quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }>;
      };
    }>;
  };
}

/** Parse a daily-bars CSV: header with a Date column + an (Adj) Close column; `#` lines ignored. */
function parseCsvBars(text: string): PriceBar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const dateIdx = header.indexOf("date");
  const closeIdx = ["adj close", "adjclose", "adj_close", "close"]
    .map((k) => header.indexOf(k))
    .find((i) => i >= 0);
  const volIdx = header.indexOf("volume"); // optional (MA8)
  if (dateIdx < 0 || closeIdx === undefined) return [];
  const bars: PriceBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = (cols[dateIdx] ?? "").trim().slice(0, 10);
    const close = Number(cols[closeIdx]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    const vol = volIdx >= 0 ? Number(cols[volIdx]) : NaN;
    bars.push({ date, close, volume: Number.isFinite(vol) && vol > 0 ? vol : null });
  }
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return bars;
}

/** CSV provider: reads `SYMBOL.csv` from `dir`. Missing file → [] (symbol unresolved). */
export function createCsvProvider(dir: string): PriceSeriesProvider {
  return {
    name: "csv",
    async fetchDaily(ticker, fromIso, toIso) {
      const sym = ticker === BENCHMARK ? "SPY" : ticker.trim().toUpperCase();
      // Accept class-share naming either way (BRK.B.csv or BRK-B.csv).
      const file = [`${sym}.csv`, `${sym.replace(/\./g, "-")}.csv`]
        .map((f) => join(dir, f))
        .find((p) => existsSync(p));
      if (!file) return [];
      return parseCsvBars(readFileSync(file, "utf8")).filter((b) => b.date >= fromIso && b.date <= toIso);
    },
  };
}

/** The configured default provider (RESEARCH_PRICE_PROVIDER: 'csv' default, or 'yahoo'). */
export function defaultProvider(): PriceSeriesProvider {
  return (process.env.RESEARCH_PRICE_PROVIDER ?? "csv").toLowerCase() === "yahoo"
    ? yahooProvider
    : createCsvProvider(DEFAULT_PRICE_DIR);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const toSeries = (bars: PriceBar[]): PriceSeries => {
  const vol = bars.filter((b) => typeof b.volume === "number" && b.volume! > 0);
  return {
    dates: bars.map((b) => b.date),
    closeByDate: new Map(bars.map((b) => [b.date, b.close])),
    volumeByDate: vol.length ? new Map(vol.map((b) => [b.date, b.volume as number])) : undefined,
  };
};

/**
 * Return a symbol's full cached series, fetching it once (whole backfill window) if not yet cached.
 * null = the source has no data for this ticker (recorded as 'unresolved' so we don't retry it).
 * `live` is set true when a network fetch actually happened, so callers can pace politely.
 */
async function ensureSeries(
  ticker: string,
  provider: PriceSeriesProvider,
  log: (m: string) => void,
): Promise<{ series: PriceSeries | null; live: boolean }> {
  const cov = symbolCoverage(ticker);
  // 'unresolved' is sticky for live sources (the symbol genuinely doesn't exist), but NOT for csv:
  // a file can be dropped in at any time, so always re-attempt the (cheap, local) read.
  if (cov?.status === "unresolved" && provider.name !== "csv") return { series: null, live: false };
  if (cov?.status === "ok") {
    const cached = cachedBars(ticker);
    if (cached.length) return { series: toSeries(cached), live: false };
  }

  const today = new Date().toISOString().slice(0, 10);
  let bars: PriceBar[];
  try {
    bars = await provider.fetchDaily(ticker, BACKFILL_START, today);
  } catch (err) {
    // Rate limit / transient: do NOT cache a coverage record, so a later run retries.
    log(`price: fetch failed for ${ticker} — ${(err as Error).message}`);
    throw err;
  }

  if (!bars.length) {
    // Don't persist a blocking 'unresolved' for csv (a file may simply not be there yet).
    if (provider.name !== "csv") {
      setSymbolCoverage({ symbol: ticker, source: provider.name, status: "unresolved", first_date: null, last_date: null });
    }
    log(`price: ${ticker} unresolved at ${provider.name}`);
    return { series: null, live: true };
  }
  upsertBars(ticker, provider.name, bars);
  setSymbolCoverage({
    symbol: ticker,
    source: provider.name,
    status: "ok",
    first_date: bars[0].date,
    last_date: bars[bars.length - 1].date,
  });
  log(`price: cached ${bars.length} bars for ${ticker} (${bars[0].date}…${bars[bars.length - 1].date})`);
  return { series: toSeries(bars), live: true };
}

export interface BuildPriceAccessOptions {
  provider?: PriceSeriesProvider;
  log?: (m: string) => void;
  /** false = bypass the DB cache entirely (load straight from the provider). For tests/one-offs. */
  cache?: boolean;
}

/**
 * Load the benchmark + every requested ticker (cache-through) and return a synchronous PriceAccess
 * the return engine can call per-event without further I/O. Tickers that don't resolve simply
 * return null from `series()` (the engine maps that to status 'unresolved_ticker').
 */
export async function buildPriceAccess(
  tickers: Iterable<string>,
  opts: BuildPriceAccessOptions = {},
): Promise<PriceAccess> {
  const provider = opts.provider ?? defaultProvider();
  const log = opts.log ?? (() => {});
  const useCache = opts.cache !== false;

  // Either the cache-through path (default) or a direct provider fetch (cache:false, for tests).
  const today = new Date().toISOString().slice(0, 10);
  const load = async (t: string): Promise<{ series: PriceSeries | null; live: boolean }> => {
    if (useCache) return ensureSeries(t, provider, log);
    const bars = await provider.fetchDaily(t, BACKFILL_START, today);
    return { series: bars.length ? toSeries(bars) : null, live: true };
  };

  const space = provider.name !== "csv"; // local CSV needs no polite spacing

  const benchRes = await load(BENCHMARK);
  if (!benchRes.series) {
    throw new Error(`benchmark ${BENCHMARK} unavailable from ${provider.name}; cannot compute returns`);
  }
  if (benchRes.live && space) await sleep(FETCH_SPACING_MS);
  const benchmark = benchRes.series;

  const unique = [...new Set([...tickers].map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const seriesByTicker = new Map<string, PriceSeries | null>();
  for (const t of unique) {
    if (t === BENCHMARK) continue;
    const { series, live } = await load(t);
    seriesByTicker.set(t, series);
    if (live && space) await sleep(FETCH_SPACING_MS);
  }

  return {
    benchmark,
    series(ticker: string): PriceSeries | null {
      const t = ticker.trim().toUpperCase();
      if (t === BENCHMARK) return benchmark;
      return seriesByTicker.get(t) ?? null;
    },
  };
}
