import { resolvedCompanies } from "../db.js";
import { aggregate, aggregateOverall, type GroupAgg, type ScoredEvent } from "./aggregate.js";
import { analysisTrades, saveTradeReturns, type AnalysisTrade, type TradeReturnRow } from "./db.js";
import { buildPriceAccess, type PriceSeriesProvider } from "./prices.js";
import {
  BENCHMARK,
  computeForwardReturns,
  preEventAbnormal,
  type Direction,
  type EventReturns,
  type HorizonLabel,
  type PriceAccess,
} from "./returns.js";
import { benjaminiHochberg, bootstrapMeanCI, mean, shrink, twoSidedP, type CI } from "./stats.js";

/**
 * Model B — how DISCLOSED congressional trades performed. Forward ABNORMAL return vs the S&P 500
 * (1d/1w/1m/3m) from the TRANSACTION date, signed by direction, rolled up per member / ticker.
 * Correlation analysis, NOT advice; amounts are RANGES so weighted figures are ESTIMATES.
 * Methodology + the applied refinements (R1–R7, R9) are in model-b-methodology.md.
 */

const HLABELS: HorizonLabel[] = ["1d", "1w", "1m", "3m"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function tradeDirection(tx_type: string): Direction | null {
  if (tx_type === "purchase") return "buy";
  if (tx_type === "sale" || tx_type === "sale_partial") return "sell";
  return null; // exchange / unknown
}

/**
 * Flag assets the engine must not price as an equity (spec §7). Best-effort over messy real data:
 * asset_type codes are inconsistent (ST=stock, GS=govt security, CS=corp bond, OP=option,
 * CT=crypto, HN=private fund) and asset_name often carries the real signal (coupon/maturity for
 * bonds). Over-flagging is safe (the row is excluded); under-flagging risks mis-pricing.
 */
export function classifyUnsupported(assetType: string | null, assetName: string): string | null {
  const s = `${assetType ?? ""} ${assetName}`.toLowerCase();
  if (/\boption\b|\bwarrant\b|\bcall\b|\bput\b|\bop\b/.test(s)) return "option";
  if (/\bbond\b|\bnote\b|municipal|\bmuni\b|treasury|\bbill\b|debenture|fixed[ -]?income|\bgs\b/.test(s))
    return "fixed_income";
  if (/\d\s*%|\bdue\s+\d|\bvar\b\s*\d|\bmatur/.test(s)) return "fixed_income";
  if (/mutual fund|money market|\bmmf\b|\bcrypto\b|\bcoin\b|\btoken\b/.test(s)) return "fund";
  return null;
}

export function amountMidpoint(min: number | null, max: number | null): number | null {
  if (min != null && max != null) return (min + max) / 2;
  return min ?? max ?? null;
}

function normalizeTicker(raw: string | null): string | null {
  if (!raw) return null;
  const t = raw.trim().toUpperCase();
  return /^[A-Z]{1,5}([.\-][A-Z])?$/.test(t) ? t : null;
}

const signedMap = (r: EventReturns): Partial<Record<HorizonLabel, number | null>> => {
  const s: Partial<Record<HorizonLabel, number | null>> = {};
  for (const h of HLABELS) s[h] = r.horizons[h].signed_return;
  return s;
};

// --- Types --------------------------------------------------------------------------------------

export interface Coverage {
  eligible: number;
  excludedNoTicker: number;
  excludedUnsupported: number;
  excludedExchange: number;
  excludedBadDate: number;
  attempted: number;
  byStatus: Record<string, number>;
  scored: number;
  online: number;
  ocr: number;
}

export interface OverallVariants {
  txn: GroupAgg; // headline: beta=1, transaction date
  txnOnline: GroupAgg; // online-only robustness cut
  disclosure: GroupAgg; // R1: entry from the filing date (investable)
  marketModel: GroupAgg; // R5: α/β expected return
  validated: GroupAgg; // R7: ticker in the SEC-resolved universe
  baselineAdjusted: GroupAgg; // R2: minus the ticker's own drift (placebo)
  buys: GroupAgg; // R9
  sells: GroupAgg; // R9
}

export interface MemberRow {
  result: GroupAgg;
  label: string;
  p1m: number | null; // two-sided p that mean 1m signed abnormal ≠ 0
  rejectedFDR: boolean; // survives Benjamini–Hochberg across members (R4)
  shrunk1m: number | null; // empirical-Bayes shrunk 1m mean (R4)
}

export interface ScoredTradeRow {
  ticker: string;
  member: string;
  direction: Direction;
  date: string;
  source: string;
  ab_1m: number;
}

export interface ModelBResult {
  generatedAt: string;
  priceProvider: string;
  benchmark: string;
  coverage: Coverage;
  overall: OverallVariants;
  bootstrap: Record<HorizonLabel, CI>; // R3: overlap-aware CI on the txn mean
  runup: { n: number; meanRunup: number | null }; // R2 summary
  byMember: MemberRow[];
  byTicker: GroupAgg[];
  byOwner: { result: GroupAgg; label: string }[]; // R6
  bestTrades: ScoredTradeRow[];
  worstTrades: ScoredTradeRow[];
}

export interface RunModelBOptions {
  log?: (m: string) => void;
  provider?: PriceSeriesProvider;
  cache?: boolean;
  dryRun?: boolean;
}

function emptyOverall(): OverallVariants {
  const e = (label: string) => aggregateOverall([], label);
  return {
    txn: e("ALL"), txnOnline: e("ONLINE"), disclosure: e("DISC"), marketModel: e("MM"),
    validated: e("VALID"), baselineAdjusted: e("ADJ"), buys: e("BUYS"), sells: e("SELLS"),
  };
}

function coverageOnly(cov: Coverage): ModelBResult {
  return {
    generatedAt: new Date().toISOString(),
    priceProvider: process.env.RESEARCH_PRICE_PROVIDER ?? "csv",
    benchmark: BENCHMARK,
    coverage: cov,
    overall: emptyOverall(),
    bootstrap: Object.fromEntries(HLABELS.map((h) => [h, { mean: null, lo: null, hi: null }])) as Record<HorizonLabel, CI>,
    runup: { n: 0, meanRunup: null },
    byMember: [],
    byTicker: [],
    byOwner: [],
    bestTrades: [],
    worstTrades: [],
  };
}

/** Per-ticker baseline drift (R2 placebo): mean forward UNSIGNED abnormal over sampled dates. */
function tickerBaseline(ticker: string, prices: PriceAccess, sampleN = 50): Record<HorizonLabel, number | null> {
  const ts = prices.series(ticker);
  const acc: Record<HorizonLabel, number[]> = { "1d": [], "1w": [], "1m": [], "3m": [] };
  if (ts && ts.dates.length) {
    const step = Math.max(1, Math.floor(ts.dates.length / sampleN));
    for (let i = 0; i < ts.dates.length; i += step) {
      const r = computeForwardReturns({ ticker, eventDate: ts.dates[i], entry: "trade", eventHasIntradayTime: false }, prices);
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

// --- Pipeline -----------------------------------------------------------------------------------

interface Prepared {
  t: AnalysisTrade;
  ticker: string;
  direction: Direction;
  weight: number | null;
  sign: number;
  validated: boolean;
}

export async function runModelB(opts: RunModelBOptions = {}): Promise<ModelBResult> {
  const log = opts.log ?? (() => {});
  const trades = analysisTrades();
  log(`Model B: ${trades.length} eligible trades (needs_review excluded).`);

  const resolvedTickers = new Set(resolvedCompanies().map((c) => c.ticker.toUpperCase())); // R7

  const cov: Coverage = {
    eligible: trades.length, excludedNoTicker: 0, excludedUnsupported: 0, excludedExchange: 0,
    excludedBadDate: 0, attempted: 0, byStatus: {}, scored: 0, online: 0, ocr: 0,
  };
  const prepared: Prepared[] = [];
  for (const t of trades) {
    const dir = tradeDirection(t.tx_type);
    if (!dir) { cov.excludedExchange++; continue; }
    if (classifyUnsupported(t.asset_type, t.asset_name)) { cov.excludedUnsupported++; continue; }
    const ticker = normalizeTicker(t.ticker);
    if (!ticker) { cov.excludedNoTicker++; continue; }
    if (!t.transaction_date || !ISO.test(t.transaction_date)) { cov.excludedBadDate++; continue; }
    prepared.push({
      t, ticker, direction: dir, weight: amountMidpoint(t.amount_min, t.amount_max),
      sign: dir === "sell" ? -1 : 1, validated: resolvedTickers.has(ticker),
    });
  }
  cov.attempted = prepared.length;

  const tickers = [...new Set(prepared.map((p) => p.ticker))];
  let prices: PriceAccess;
  try {
    prices = await buildPriceAccess(tickers, { log, provider: opts.provider, cache: opts.cache });
  } catch (err) {
    if (/benchmark .* unavailable/.test((err as Error).message)) {
      log(`Model B: ${(err as Error).message} — no price data; coverage-only report.`);
      return coverageOnly(cov);
    }
    throw err;
  }

  // Pass 1 — score each trade across variants (txn baseline, disclosure-date, market-model, run-up).
  interface Scored extends Prepared {
    txn: Partial<Record<HorizonLabel, number | null>>;
    disc: Partial<Record<HorizonLabel, number | null>>;
    mm: Partial<Record<HorizonLabel, number | null>>;
    runup: number | null;
    entryDate: string | null;
  }
  const scored: Scored[] = [];
  const persistRows: TradeReturnRow[] = [];
  const memberLabel = new Map<string, string>();

  for (const p of prepared) {
    const { t, ticker, direction } = p;
    const rTxn = computeForwardReturns({ ticker, eventDate: t.transaction_date!, entry: "trade", eventHasIntradayTime: false, direction }, prices);
    cov.byStatus[rTxn.status] = (cov.byStatus[rTxn.status] ?? 0) + 1;
    memberLabel.set(t.member_id, `${t.full_name} · ${t.chamber}${t.state ? "-" + t.state : ""}`);

    const txn = signedMap(rTxn);
    const isScored = rTxn.status === "ok" && HLABELS.some((h) => typeof txn[h] === "number");

    let disc: Partial<Record<HorizonLabel, number | null>> = {};
    let mm: Partial<Record<HorizonLabel, number | null>> = {};
    let runup: number | null = null;
    if (isScored) {
      if (t.filed_date && ISO.test(t.filed_date)) {
        disc = signedMap(computeForwardReturns({ ticker, eventDate: t.filed_date, entry: "statement", eventHasIntradayTime: false, direction }, prices));
      }
      mm = signedMap(computeForwardReturns({ ticker, eventDate: t.transaction_date!, entry: "trade", eventHasIntradayTime: false, direction }, prices, { marketModel: true }));
      runup = preEventAbnormal(ticker, t.transaction_date!, prices);
      cov.scored++;
      if (t.source === "ocr") cov.ocr++; else cov.online++;
      scored.push({ ...p, txn, disc, mm, runup, entryDate: rTxn.entry_date });
    }

    persistRows.push({
      trade_id: t.id, member_id: t.member_id, ticker, direction, entry_date: rTxn.entry_date,
      status: rTxn.status, weight: p.weight, source: t.source, owner: t.owner, validated: p.validated ? 1 : 0,
      runup, ab_1d: txn["1d"] ?? null, ab_1w: txn["1w"] ?? null, ab_1m: txn["1m"] ?? null, ab_3m: txn["3m"] ?? null,
      st_1d: rTxn.horizons["1d"].status, st_1w: rTxn.horizons["1w"].status,
      st_1m: rTxn.horizons["1m"].status, st_3m: rTxn.horizons["3m"].status,
      extra_json: isScored ? JSON.stringify({ disc, mm }) : null,
    });
  }

  // Pass 2 — placebo baseline per scored ticker, then baseline-adjusted signed returns (R2).
  const baselines = new Map<string, Record<HorizonLabel, number | null>>();
  for (const tk of new Set(scored.map((s) => s.ticker))) baselines.set(tk, tickerBaseline(tk, prices));
  const baselineAdjEvents: ScoredEvent[] = scored.map((s) => {
    const base = baselines.get(s.ticker)!;
    const adj: Partial<Record<HorizonLabel, number | null>> = {};
    for (const h of HLABELS) {
      const v = s.txn[h];
      const b = base[h];
      adj[h] = typeof v === "number" && typeof b === "number" ? v - s.sign * b : (typeof v === "number" ? v : null);
    }
    return { group: "ADJ", signed: adj, weight: s.weight ?? 1 };
  });

  if (opts.dryRun) log(`Model B: scored ${cov.scored} trades (dry-run — not persisting).`);
  else { saveTradeReturns(persistRows); log(`Model B: scored ${cov.scored}; persisted ${persistRows.length} rows.`); }

  // --- Aggregate ---
  const ev = (pick: (s: Scored) => Partial<Record<HorizonLabel, number | null>>, group: (s: Scored) => string): ScoredEvent[] =>
    scored.map((s) => ({ group: group(s), signed: pick(s), weight: s.weight ?? 1, tag: s.t.source }));

  const txnMemberEvents = ev((s) => s.txn, (s) => s.t.member_id);
  const overall: OverallVariants = {
    txn: aggregateOverall(txnMemberEvents, "ALL"),
    txnOnline: aggregateOverall(txnMemberEvents.filter((e) => e.tag === "online"), "ONLINE"),
    disclosure: aggregateOverall(ev((s) => s.disc, () => "DISC"), "DISC"),
    marketModel: aggregateOverall(ev((s) => s.mm, () => "MM"), "MM"),
    validated: aggregateOverall(scored.filter((s) => s.validated).map((s) => ({ group: "VALID", signed: s.txn, weight: s.weight ?? 1 })), "VALID"),
    baselineAdjusted: aggregateOverall(baselineAdjEvents, "ADJ"),
    buys: aggregateOverall(scored.filter((s) => s.direction === "buy").map((s) => ({ group: "BUYS", signed: s.txn, weight: s.weight ?? 1 })), "BUYS"),
    sells: aggregateOverall(scored.filter((s) => s.direction === "sell").map((s) => ({ group: "SELLS", signed: s.txn, weight: s.weight ?? 1 })), "SELLS"),
  };

  // R3 — overlap-aware bootstrap: cluster by (ticker, year-month), bootstrap over cluster means.
  const bootstrap = {} as Record<HorizonLabel, CI>;
  for (const h of HLABELS) {
    const clusters = new Map<string, number[]>();
    for (const s of scored) {
      const v = s.txn[h];
      if (typeof v !== "number") continue;
      const key = `${s.ticker}|${(s.entryDate ?? "").slice(0, 7)}`;
      (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(v);
    }
    const clusterMeans = [...clusters.values()].map((vs) => mean(vs));
    bootstrap[h] = bootstrapMeanCI(clusterMeans);
  }

  // R2 — run-up summary.
  const runups = scored.map((s) => s.runup).filter((x): x is number => typeof x === "number");
  const runup = { n: runups.length, meanRunup: runups.length ? mean(runups) : null };

  // R4 — per member: p-value on 1m mean, BH-FDR across members, shrunk mean toward the grand mean.
  const memberAgg = aggregate(txnMemberEvents);
  const grand1m = overall.txn.horizons["1m"].mean ?? 0;
  const memberP = memberAgg.map((g) => twoSidedP(g.horizons["1m"].mean ?? 0, g.horizons["1m"].std, g.horizons["1m"].n));
  const memberRej = benjaminiHochberg(memberP, 0.1);
  const byMember: MemberRow[] = memberAgg.map((g, i) => ({
    result: g,
    label: memberLabel.get(g.group) ?? g.group,
    p1m: memberP[i],
    rejectedFDR: memberRej[i],
    shrunk1m: g.horizons["1m"].n ? shrink(g.horizons["1m"].mean ?? 0, g.horizons["1m"].n, grand1m) : null,
  }));

  const byTicker = aggregate(ev((s) => s.txn, (s) => s.ticker));
  const byOwner = aggregate(ev((s) => s.txn, (s) => s.t.owner)).map((g) => ({ result: g, label: g.group }));

  // Best/worst single trades by 1m signed abnormal (anecdotes).
  const scoredTrades: ScoredTradeRow[] = scored
    .filter((s) => typeof s.txn["1m"] === "number")
    .map((s) => ({ ticker: s.ticker, member: s.t.full_name, direction: s.direction, date: s.t.transaction_date!, source: s.t.source, ab_1m: s.txn["1m"] as number }));
  scoredTrades.sort((a, b) => b.ab_1m - a.ab_1m);

  return {
    generatedAt: new Date().toISOString(),
    priceProvider: process.env.RESEARCH_PRICE_PROVIDER ?? "csv",
    benchmark: BENCHMARK,
    coverage: cov,
    overall,
    bootstrap,
    runup,
    byMember,
    byTicker,
    byOwner,
    bestTrades: scoredTrades.slice(0, 15),
    worstTrades: scoredTrades.slice(-15).reverse(),
  };
}
