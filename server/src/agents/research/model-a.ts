import { resolvedCompanies } from "../db.js";
import { aggregate, aggregateOverall, type GroupAgg, type ScoredEvent } from "./aggregate.js";
import { analysisMentions, newsDatesByTicker, saveStatementReturns, type AnalysisMention, type StatementReturnRow } from "./db.js";
import { buildPriceAccess, type PriceSeriesProvider } from "./prices.js";
import {
  abnormalVolume,
  BENCHMARK,
  computeForwardReturns,
  preEventAbnormal,
  type EventReturns,
  type HorizonLabel,
  type PriceAccess,
} from "./returns.js";
import { benjaminiHochberg, bootstrapMeanCI, mean, rng, shrink, twoSidedP, type CI } from "./stats.js";

/**
 * Model A — do a public figure's STATEMENTS about stocks precede price movement? For each extracted
 * mention we ask the shared engine for the forward ABNORMAL return vs the S&P 500 (1d/1w/1m/3m) from
 * the statement, entered the first close strictly AFTER it was public (no look-ahead), then roll up
 * per figure and per ticker.
 *
 * UNSIGNED: a statement has no buy/sell direction, so we measure the move itself (hit rate = share
 * that rose). This is CORRELATION analysis, not a signal or advice — figures very often mention names
 * already in the news/moving, so the pre-event run-up + baseline-adjusted cuts below are essential
 * context. See model-a-methodology.md.
 */

const HLABELS: HorizonLabel[] = ["1d", "1w", "1m", "3m"];

const abnormalMap = (r: EventReturns): Partial<Record<HorizonLabel, number | null>> => {
  const s: Partial<Record<HorizonLabel, number | null>> = {};
  for (const h of HLABELS) s[h] = r.horizons[h].abnormal_return;
  return s;
};

/** Lookback window (days) for the MA2 news-coincidence control. */
const NEWS_WINDOW_DAYS = Number(process.env.RESEARCH_NEWS_WINDOW_DAYS ?? 7);
/** MA3: collapse repeat mentions of the same (figure, ticker) within this many days. */
const DEDUP_WINDOW_DAYS = Number(process.env.RESEARCH_DEDUP_WINDOW_DAYS ?? 5);

function addDaysIso(dateOnly: string, n: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const daysBetween = (aIso: string, bIso: string): number =>
  Math.abs(Date.parse(`${bIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${aIso.slice(0, 10)}T00:00:00Z`)) / 86_400_000;

/** FNV-1a string hash → a stable per-ticker RNG seed (so placebo draws are reproducible). */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const PLACEBO_SAMPLES = 100; // random dates sampled per ticker
const PLACEBO_ITERS = 2000; // permutation resamples of the matched placebo set

/** Did the ticker have collected news in [saidAt − windowDays, saidAt]? (MA2 reverse-causation control.) */
export function hadPriorNews(newsDatesAsc: string[], saidAt: string, windowDays: number): boolean {
  const hi = saidAt.slice(0, 10);
  const lo = addDaysIso(hi, -windowDays);
  for (const d of newsDatesAsc) {
    if (d > hi) break;
    if (d >= lo) return true;
  }
  return false;
}

export interface CoverageA {
  mentions: number;
  byMethod: Record<string, number>;
  byStatus: Record<string, number>;
  scored: number;
}

export interface OverallVariantsA {
  all: GroupAgg;
  cashtagOnly: GroupAgg; // high-confidence extraction (cashtag/explicit) cut
  marketModel: GroupAgg; // R5
  validated: GroupAgg; // R7
  baselineAdjusted: GroupAgg; // R2
}

export interface FigureRow {
  result: GroupAgg;
  label: string;
  p1m: number | null;
  rejectedFDR: boolean;
  shrunk1m: number | null;
}

export interface MoveRow {
  ticker: string;
  figure: string;
  date: string;
  method: string;
  ab_1m: number;
}

/** MA6 — matched-date placebo: actual mention move vs random dates in the same ticker. */
export interface PlaceboCell {
  actual: number | null;
  placebo: number | null;
  excess: number | null; // actual − placebo
  p: number | null; // empirical one-sided p (share of placebo draws ≥ actual)
  n: number;
}

/** MA1 — sentiment-signed results: a directional mention is "right" if the price moved its way. */
export interface SentimentSummary {
  bullish: number;
  bearish: number;
  neutral: number;
  signedOverall: GroupAgg; // directional mentions only; hit rate = share "directionally right"
  byFigure: { result: GroupAgg; label: string }[];
}

/** MA2 — split scored mentions by whether the ticker was already in the news going in. */
export interface NewsCoincidence {
  windowDays: number;
  covered: number; // scored mentions whose ticker has any collected news (assessable)
  noCoverage: number; // scored mentions with no news coverage at all (can't assess)
  priorNews: number;
  fresh: number;
  priorAgg: GroupAgg; // abnormal returns for "already in the news" mentions
  freshAgg: GroupAgg; // abnormal returns for "fresh" mentions (covered, but no prior-window news)
}

export interface ModelAResult {
  generatedAt: string;
  priceProvider: string;
  benchmark: string;
  coverage: CoverageA;
  overall: OverallVariantsA;
  bootstrap: Record<HorizonLabel, CI>;
  runup: { n: number; meanRunup: number | null };
  abnVolume: { n: number; mean: number | null }; // MA8
  sentiment: SentimentSummary; // MA1
  newsCoincidence: NewsCoincidence; // MA2
  dedup: { collapsed: number; windowDays: number; agg: GroupAgg }; // MA3
  byFigureKind: GroupAgg[]; // MA4
  bySource: GroupAgg[]; // MA5
  placebo: Record<HorizonLabel, PlaceboCell>; // MA6
  byFigure: FigureRow[];
  byTicker: GroupAgg[];
  byMethod: GroupAgg[];
  topMoves: MoveRow[];
  bottomMoves: MoveRow[];
}

export interface RunModelAOptions {
  log?: (m: string) => void;
  provider?: PriceSeriesProvider;
  cache?: boolean;
  dryRun?: boolean;
}

function emptyOverall(): OverallVariantsA {
  const e = (l: string) => aggregateOverall([], l);
  return { all: e("ALL"), cashtagOnly: e("CASH"), marketModel: e("MM"), validated: e("VALID"), baselineAdjusted: e("ADJ") };
}

function coverageOnly(cov: CoverageA): ModelAResult {
  return {
    generatedAt: new Date().toISOString(),
    priceProvider: process.env.RESEARCH_PRICE_PROVIDER ?? "csv",
    benchmark: BENCHMARK,
    coverage: cov,
    overall: emptyOverall(),
    bootstrap: Object.fromEntries(HLABELS.map((h) => [h, { mean: null, lo: null, hi: null }])) as Record<HorizonLabel, CI>,
    runup: { n: 0, meanRunup: null },
    abnVolume: { n: 0, mean: null },
    sentiment: { bullish: 0, bearish: 0, neutral: 0, signedOverall: aggregateOverall([], "SIGNED"), byFigure: [] },
    newsCoincidence: {
      windowDays: NEWS_WINDOW_DAYS, covered: 0, noCoverage: 0, priorNews: 0, fresh: 0,
      priorAgg: aggregateOverall([], "PRIOR"), freshAgg: aggregateOverall([], "FRESH"),
    },
    dedup: { collapsed: 0, windowDays: DEDUP_WINDOW_DAYS, agg: aggregateOverall([], "DEDUP") },
    byFigureKind: [],
    bySource: [],
    placebo: Object.fromEntries(HLABELS.map((h) => [h, { actual: null, placebo: null, excess: null, p: null, n: 0 }])) as Record<HorizonLabel, PlaceboCell>,
    byFigure: [],
    byTicker: [],
    byMethod: [],
    topMoves: [],
    bottomMoves: [],
  };
}

/** Per-ticker baseline drift (R2 placebo): mean forward abnormal over sampled dates. */
function tickerBaseline(ticker: string, prices: PriceAccess, sampleN = 50): Record<HorizonLabel, number | null> {
  const ts = prices.series(ticker);
  const acc: Record<HorizonLabel, number[]> = { "1d": [], "1w": [], "1m": [], "3m": [] };
  if (ts && ts.dates.length) {
    const step = Math.max(1, Math.floor(ts.dates.length / sampleN));
    for (let i = 0; i < ts.dates.length; i += step) {
      const r = computeForwardReturns({ ticker, eventDate: ts.dates[i], entry: "statement", eventHasIntradayTime: false }, prices);
      if (r.status !== "ok") continue;
      for (const h of HLABELS) {
        const a = r.horizons[h].abnormal_return;
        if (typeof a === "number") acc[h].push(a);
      }
    }
  }
  return {
    "1d": acc["1d"].length ? mean(acc["1d"]) : null,
    "1w": acc["1w"].length ? mean(acc["1w"]) : null,
    "1m": acc["1m"].length ? mean(acc["1m"]) : null,
    "3m": acc["3m"].length ? mean(acc["3m"]) : null,
  };
}

export async function runModelA(opts: RunModelAOptions = {}): Promise<ModelAResult> {
  const log = opts.log ?? (() => {});
  const mentions = analysisMentions();
  log(`Model A: ${mentions.length} mentions to score.`);

  const resolvedTickers = new Set(resolvedCompanies().map((c) => c.ticker.toUpperCase()));
  const news = newsDatesByTicker(); // MA2: collected news dates per ticker
  const cov: CoverageA = { mentions: mentions.length, byMethod: {}, byStatus: {}, scored: 0 };
  for (const m of mentions) cov.byMethod[m.method] = (cov.byMethod[m.method] ?? 0) + 1;

  if (!mentions.length) return coverageOnly(cov);

  const tickers = [...new Set(mentions.map((m) => m.ticker))];
  let prices: PriceAccess;
  try {
    prices = await buildPriceAccess(tickers, { log, provider: opts.provider, cache: opts.cache });
  } catch (err) {
    if (/benchmark .* unavailable/.test((err as Error).message)) {
      log(`Model A: ${(err as Error).message} — no price data; coverage-only report.`);
      return coverageOnly(cov);
    }
    throw err;
  }

  interface Scored {
    m: AnalysisMention;
    validated: boolean;
    newsCovered: boolean;
    priorNews: boolean;
    ab: Partial<Record<HorizonLabel, number | null>>;
    mm: Partial<Record<HorizonLabel, number | null>>;
    runup: number | null;
    avol: number | null;
    entryDate: string | null;
  }
  const scored: Scored[] = [];
  const persistRows: StatementReturnRow[] = [];
  const figureLabel = new Map<string, string>();

  for (const m of mentions) {
    const hasTime = m.has_time === 1;
    const r = computeForwardReturns({ ticker: m.ticker, eventDate: m.said_at, entry: "statement", eventHasIntradayTime: hasTime }, prices);
    cov.byStatus[r.status] = (cov.byStatus[r.status] ?? 0) + 1;
    figureLabel.set(m.figure_id, `${m.figure_name}${m.figure_kind ? " · " + m.figure_kind : ""}`);

    const ab = abnormalMap(r);
    const isScored = r.status === "ok" && HLABELS.some((h) => typeof ab[h] === "number");
    let mm: Partial<Record<HorizonLabel, number | null>> = {};
    let runup: number | null = null;
    const validated = resolvedTickers.has(m.ticker);
    const newsDates = news.get(m.ticker);
    const newsCovered = !!newsDates;
    const priorNews = newsCovered ? hadPriorNews(newsDates!, m.said_at, NEWS_WINDOW_DAYS) : false;
    if (isScored) {
      mm = abnormalMap(computeForwardReturns({ ticker: m.ticker, eventDate: m.said_at, entry: "statement", eventHasIntradayTime: hasTime }, prices, { marketModel: true }));
      runup = preEventAbnormal(m.ticker, m.said_at, prices);
      const avol = abnormalVolume(m.ticker, m.said_at, prices); // MA8
      cov.scored++;
      scored.push({ m, validated, newsCovered, priorNews, ab, mm, runup, avol, entryDate: r.entry_date });
    }

    persistRows.push({
      mention_id: m.id, figure_id: m.figure_id, ticker: m.ticker, entry_date: r.entry_date, status: r.status,
      validated: validated ? 1 : 0, runup, ab_1d: ab["1d"] ?? null, ab_1w: ab["1w"] ?? null,
      ab_1m: ab["1m"] ?? null, ab_3m: ab["3m"] ?? null,
      st_1d: r.horizons["1d"].status, st_1w: r.horizons["1w"].status, st_1m: r.horizons["1m"].status, st_3m: r.horizons["3m"].status,
      extra_json: isScored ? JSON.stringify({ mm, priorNews, newsCovered }) : null,
    });
  }

  // R2 — placebo baseline per ticker → baseline-adjusted abnormal.
  const baselines = new Map<string, Record<HorizonLabel, number | null>>();
  for (const tk of new Set(scored.map((s) => s.m.ticker))) baselines.set(tk, tickerBaseline(tk, prices));
  const baselineAdjEvents: ScoredEvent[] = scored.map((s) => {
    const base = baselines.get(s.m.ticker)!;
    const adj: Partial<Record<HorizonLabel, number | null>> = {};
    for (const h of HLABELS) {
      const v = s.ab[h];
      const b = base[h];
      adj[h] = typeof v === "number" && typeof b === "number" ? v - b : (typeof v === "number" ? v : null);
    }
    return { group: "ADJ", signed: adj, weight: 1 };
  });

  if (opts.dryRun) log(`Model A: scored ${cov.scored} mentions (dry-run — not persisting).`);
  else { saveStatementReturns(persistRows); log(`Model A: scored ${cov.scored}; persisted ${persistRows.length} rows.`); }

  // Aggregate. Weight = extraction confidence so the weighted mean leans on reliable mentions.
  const ev = (pick: (s: Scored) => Partial<Record<HorizonLabel, number | null>>, group: (s: Scored) => string): ScoredEvent[] =>
    scored.map((s) => ({ group: group(s), signed: pick(s), weight: s.m.confidence, tag: s.m.method }));

  const figEvents = ev((s) => s.ab, (s) => s.m.figure_id);
  const overall: OverallVariantsA = {
    all: aggregateOverall(figEvents, "ALL"),
    cashtagOnly: aggregateOverall(figEvents.filter((e) => e.tag === "cashtag" || e.tag === "explicit"), "CASH"),
    marketModel: aggregateOverall(ev((s) => s.mm, () => "MM"), "MM"),
    validated: aggregateOverall(scored.filter((s) => s.validated).map((s) => ({ group: "VALID", signed: s.ab, weight: s.m.confidence })), "VALID"),
    baselineAdjusted: aggregateOverall(baselineAdjEvents, "ADJ"),
  };

  // R3 — overlap-aware bootstrap: cluster by (ticker, month).
  const bootstrap = {} as Record<HorizonLabel, CI>;
  for (const h of HLABELS) {
    const clusters = new Map<string, number[]>();
    for (const s of scored) {
      const v = s.ab[h];
      if (typeof v !== "number") continue;
      const key = `${s.m.ticker}|${(s.entryDate ?? "").slice(0, 7)}`;
      (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(v);
    }
    bootstrap[h] = bootstrapMeanCI([...clusters.values()].map((vs) => mean(vs)));
  }

  const runups = scored.map((s) => s.runup).filter((x): x is number => typeof x === "number");
  const runup = { n: runups.length, meanRunup: runups.length ? mean(runups) : null };

  // MA8 — abnormal volume on the statement day vs trailing average (corroborating signal).
  const avols = scored.map((s) => s.avol).filter((x): x is number => typeof x === "number");
  const abnVolume = { n: avols.length, mean: avols.length ? mean(avols) : null };

  // MA2 — news-coincidence control: split assessable mentions into prior-news vs fresh.
  const covered = scored.filter((s) => s.newsCovered);
  const priorList = covered.filter((s) => s.priorNews);
  const freshList = covered.filter((s) => !s.priorNews);
  const newsCoincidence: NewsCoincidence = {
    windowDays: NEWS_WINDOW_DAYS,
    covered: covered.length,
    noCoverage: scored.length - covered.length,
    priorNews: priorList.length,
    fresh: freshList.length,
    priorAgg: aggregateOverall(priorList.map((s) => ({ group: "PRIOR", signed: s.ab, weight: s.m.confidence })), "PRIOR"),
    freshAgg: aggregateOverall(freshList.map((s) => ({ group: "FRESH", signed: s.ab, weight: s.m.confidence })), "FRESH"),
  };

  // MA1 — sentiment-signed: bullish → +abnormal, bearish → −abnormal; "right" if it moved their way.
  const sentSign = (s: Scored) => (s.m.sentiment === "bullish" ? 1 : s.m.sentiment === "bearish" ? -1 : 0);
  const directional = scored.filter((s) => sentSign(s) !== 0);
  const signedEvents: ScoredEvent[] = directional.map((s) => {
    const sign = sentSign(s);
    const signed: Partial<Record<HorizonLabel, number | null>> = {};
    for (const h of HLABELS) {
      const v = s.ab[h];
      signed[h] = typeof v === "number" ? sign * v : null;
    }
    return { group: s.m.figure_id, signed, weight: s.m.confidence };
  });
  const sentiment: SentimentSummary = {
    bullish: scored.filter((s) => s.m.sentiment === "bullish").length,
    bearish: scored.filter((s) => s.m.sentiment === "bearish").length,
    neutral: scored.filter((s) => !s.m.sentiment || s.m.sentiment === "neutral").length,
    signedOverall: aggregateOverall(signedEvents.map((e) => ({ ...e, group: "SIGNED" })), "SIGNED"),
    byFigure: aggregate(signedEvents).map((g) => ({ result: g, label: figureLabel.get(g.group) ?? g.group })),
  };

  // MA3 — de-duplication: keep only the first mention of a (figure, ticker) within DEDUP_WINDOW_DAYS.
  const dedupKeep = new Set<number>();
  const lastKept = new Map<string, string>();
  for (const s of [...scored].sort((a, b) => a.m.said_at.localeCompare(b.m.said_at))) {
    const key = `${s.m.figure_id}|${s.m.ticker}`;
    const prev = lastKept.get(key);
    if (!prev || daysBetween(prev, s.m.said_at) > DEDUP_WINDOW_DAYS) {
      dedupKeep.add(s.m.id);
      lastKept.set(key, s.m.said_at);
    }
  }
  const dedupEvents = scored.filter((s) => dedupKeep.has(s.m.id)).map((s) => ({ group: "DEDUP", signed: s.ab, weight: s.m.confidence }));
  const dedup = { collapsed: scored.length - dedupKeep.size, windowDays: DEDUP_WINDOW_DAYS, agg: aggregateOverall(dedupEvents, "DEDUP") };

  // MA4 — figure-type stratification; MA5 — source/medium stratification.
  const byFigureKind = aggregate(ev((s) => s.ab, (s) => s.m.figure_kind ?? "unknown"));
  const bySource = aggregate(ev((s) => s.ab, (s) => s.m.source ?? "unknown"));

  // MA6 — matched-date placebo: per ticker, sample random dates' forward abnormal (the null), then
  // permutation-test whether the actual mentions moved more than random days in the SAME tickers.
  const placeboPool = new Map<string, Record<HorizonLabel, number[]>>();
  for (const tk of new Set(scored.map((s) => s.m.ticker))) {
    const ts = prices.series(tk);
    const pool: Record<HorizonLabel, number[]> = { "1d": [], "1w": [], "1m": [], "3m": [] };
    if (ts && ts.dates.length) {
      const r = rng(hashStr(tk));
      for (let k = 0; k < PLACEBO_SAMPLES; k++) {
        const d = ts.dates[Math.floor(r() * ts.dates.length)];
        const er = computeForwardReturns({ ticker: tk, eventDate: d, entry: "statement", eventHasIntradayTime: false }, prices);
        if (er.status !== "ok") continue;
        for (const h of HLABELS) {
          const a = er.horizons[h].abnormal_return;
          if (typeof a === "number") pool[h].push(a);
        }
      }
    }
    placeboPool.set(tk, pool);
  }
  const placebo = {} as Record<HorizonLabel, PlaceboCell>;
  const prng = rng(424242);
  for (const h of HLABELS) {
    const withVal = scored.filter((s) => typeof s.ab[h] === "number" && (placeboPool.get(s.m.ticker)?.[h].length ?? 0) > 0);
    const actualVals = withVal.map((s) => s.ab[h] as number);
    const actualMean = actualVals.length ? mean(actualVals) : null;
    const poolMeans = withVal.map((s) => mean(placeboPool.get(s.m.ticker)![h]));
    const placeboMean = poolMeans.length ? mean(poolMeans) : null;
    let ge = 0;
    let valid = 0;
    if (actualMean != null && withVal.length) {
      for (let it = 0; it < PLACEBO_ITERS; it++) {
        let sum = 0;
        for (const s of withVal) {
          const p = placeboPool.get(s.m.ticker)![h];
          sum += p[Math.floor(prng() * p.length)];
        }
        valid++;
        if (sum / withVal.length >= actualMean) ge++;
      }
    }
    placebo[h] = {
      actual: actualMean,
      placebo: placeboMean,
      excess: actualMean != null && placeboMean != null ? actualMean - placeboMean : null,
      p: valid ? ge / valid : null,
      n: actualVals.length,
    };
  }

  // R4 — per figure: p-value, FDR across figures, shrinkage.
  const figAgg = aggregate(figEvents);
  const grand1m = overall.all.horizons["1m"].mean ?? 0;
  const figP = figAgg.map((g) => twoSidedP(g.horizons["1m"].mean ?? 0, g.horizons["1m"].std, g.horizons["1m"].n));
  const figRej = benjaminiHochberg(figP, 0.1);
  const byFigure: FigureRow[] = figAgg.map((g, i) => ({
    result: g,
    label: figureLabel.get(g.group) ?? g.group,
    p1m: figP[i],
    rejectedFDR: figRej[i],
    shrunk1m: g.horizons["1m"].n ? shrink(g.horizons["1m"].mean ?? 0, g.horizons["1m"].n, grand1m) : null,
  }));

  const byTicker = aggregate(ev((s) => s.ab, (s) => s.m.ticker));
  const byMethod = aggregate(ev((s) => s.ab, (s) => s.m.method));

  const moves: MoveRow[] = scored
    .filter((s) => typeof s.ab["1m"] === "number")
    .map((s) => ({ ticker: s.m.ticker, figure: s.m.figure_name, date: s.m.said_at.slice(0, 10), method: s.m.method, ab_1m: s.ab["1m"] as number }));
  moves.sort((a, b) => b.ab_1m - a.ab_1m);

  return {
    generatedAt: new Date().toISOString(),
    priceProvider: process.env.RESEARCH_PRICE_PROVIDER ?? "csv",
    benchmark: BENCHMARK,
    coverage: cov,
    overall,
    bootstrap,
    runup,
    abnVolume,
    sentiment,
    newsCoincidence,
    dedup,
    byFigureKind,
    bySource,
    placebo,
    byFigure,
    byTicker,
    byMethod,
    topMoves: moves.slice(0, 15),
    bottomMoves: moves.slice(-15).reverse(),
  };
}
