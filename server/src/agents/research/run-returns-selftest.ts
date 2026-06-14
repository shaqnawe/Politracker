import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, type ScoredEvent } from "./aggregate.js";
import { hadPriorNews } from "./model-a.js";
import { amountMidpoint, classifyUnsupported, tradeDirection } from "./model-b.js";
import { classifySentiment, sentimentForMention } from "./statements-sentiment.js";
import { createCsvProvider } from "./prices.js";
import { buildPriceAccess } from "./prices.js";
import { abnormalVolume, computeForwardReturns, isUsEasternDst, preEventAbnormal, type ComputeInput, type EventReturns } from "./returns.js";
import { buildExtractor, extractMentions } from "./statements-extract.js";
import { benjaminiHochberg, bootstrapMeanCI, ols, shrink } from "./stats.js";

/**
 * Deterministic self-test of the return engine against a controlled SYNTHETIC price fixture
 * (./fixtures/prices — NOT real market data). Known-answer + internal-consistency + status-routing
 * checks: no network, fully reproducible. Run: npm run research:selftest
 */

const FIXTURE_DIR = resolve(fileURLToPath(import.meta.url), "../fixtures/prices");
const APPROX = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

const fails: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) fails.push(msg);
};

function compute(prices: Awaited<ReturnType<typeof buildPriceAccess>>, input: ComputeInput): EventReturns {
  return computeForwardReturns(input, prices);
}

async function main() {
  // Use ONLY the fixture, and cache:false so the synthetic bars never touch the operational DB.
  const prices = await buildPriceAccess(["AAPL", "SURGE", "DELIST", "GAPPY", "ZZZZ"], {
    provider: createCsvProvider(FIXTURE_DIR),
    cache: false,
  });

  const base = { eventDate: "2023-05-24", entry: "trade", eventHasIntradayTime: false } as const;

  // 1) AAPL buy — entry anchoring + return math + internal consistency.
  const buy = compute(prices, { ...base, ticker: "AAPL", direction: "buy" });
  check(buy.status === "ok", "AAPL buy status should be ok");
  check(buy.entry_date === "2023-05-24", `trade entry should be 2023-05-24, got ${buy.entry_date}`);
  check(buy.entry_price === 103.4, `AAPL entry price should be 103.4, got ${buy.entry_price}`); // 100 + 0.2*17
  for (const h of ["1d", "1w", "1m", "3m"] as const) {
    const x = buy.horizons[h];
    check(x.status === "ok", `AAPL ${h} should be ok`);
    if (x.raw_return !== null && x.benchmark_return !== null && x.abnormal_return !== null) {
      check(APPROX(x.abnormal_return, x.raw_return - x.benchmark_return), `AAPL ${h}: abnormal must equal raw - benchmark`);
      check(APPROX(x.signed_return!, x.abnormal_return), `AAPL ${h}: buy signed must equal abnormal`);
    }
  }

  // 2) AAPL sell — signed return must be the exact negation of the buy's.
  const sell = compute(prices, { ...base, ticker: "AAPL", direction: "sell" });
  for (const h of ["1d", "1w", "1m", "3m"] as const) {
    const s = sell.horizons[h].signed_return, b = buy.horizons[h].signed_return;
    if (s !== null && b !== null) check(APPROX(s, -b), `AAPL ${h}: sell signed must be -1 × buy signed`);
  }

  // 3) statement entry policies (spec §4).
  check(
    compute(prices, { ticker: "AAPL", eventDate: "2023-05-24", entry: "statement", eventHasIntradayTime: false }).entry_date === "2023-05-25",
    "date-only statement on a trading day → entry next trading day (2023-05-25)",
  );
  check(
    compute(prices, { ticker: "AAPL", eventDate: "2023-05-24T13:00:00Z", entry: "statement", eventHasIntradayTime: true }).entry_date === "2023-05-24",
    "intraday statement BEFORE the close → entry same trading day (2023-05-24)",
  );
  check(
    compute(prices, { ticker: "AAPL", eventDate: "2023-05-24T21:00:00Z", entry: "statement", eventHasIntradayTime: true }).entry_date === "2023-05-25",
    "intraday statement AFTER the close → entry next trading day (2023-05-25)",
  );
  check(
    compute(prices, { ticker: "AAPL", eventDate: "2023-05-27", entry: "statement", eventHasIntradayTime: false }).entry_date === "2023-05-29",
    "statement on a weekend → entry next trading day (2023-05-29)",
  );

  // 4) SURGE buy — known-answer: 100 → 140 step = +40% raw at 1d, clearly positive abnormal.
  const surge = compute(prices, { ...base, ticker: "SURGE", direction: "buy" });
  check(surge.entry_price === 100, `SURGE entry price should be 100, got ${surge.entry_price}`);
  check(surge.horizons["1d"].raw_return !== null && APPROX(surge.horizons["1d"].raw_return!, 0.4), "SURGE 1d raw return should be exactly +40%");
  check((surge.horizons["1m"].abnormal_return ?? 0) > 0.3, "SURGE 1m abnormal should be strongly positive");

  // 5) unknown ticker → unresolved_ticker, all horizons null.
  const unk = compute(prices, { ...base, ticker: "ZZZZ", direction: "buy" });
  check(unk.status === "unresolved_ticker", "ZZZZ should be unresolved_ticker");
  check(unk.horizons["1m"].raw_return === null, "unresolved horizons must be null (no fabrication)");

  // 6) delisting → 1d/1w ok, 1m/3m delisted (series ends at E+10).
  const del = compute(prices, { ...base, ticker: "DELIST", direction: "buy" });
  check(del.horizons["1d"].status === "ok" && del.horizons["1w"].status === "ok", "DELIST near horizons should resolve");
  check(del.horizons["1m"].status === "delisted" && del.horizons["3m"].status === "delisted", "DELIST far horizons should be 'delisted'");
  check(del.horizons["3m"].raw_return === null, "delisted horizon must be null");

  // 7) mid-series gap wider than tolerance → price_gap at 1m, but 3m still ok.
  const gap = compute(prices, { ...base, ticker: "GAPPY", direction: "buy" });
  check(gap.horizons["1m"].status === "price_gap", `GAPPY 1m should be price_gap, got ${gap.horizons["1m"].status}`);
  check(gap.horizons["3m"].status === "ok", "GAPPY 3m should recover to ok");

  // 8) too-recent event → far horizons insufficient_history.
  const recent = compute(prices, { ...base, eventDate: "2023-09-28", ticker: "AAPL", direction: "buy" });
  check(recent.horizons["3m"].status === "insufficient_history", "event near calendar end → 3m insufficient_history");

  // 9) model-flagged non-equity → unsupported_asset.
  check(
    compute(prices, { ...base, ticker: "AAPL", direction: "buy", unsupportedAsset: true }).status === "unsupported_asset",
    "unsupportedAsset flag → unsupported_asset",
  );

  // 10) event before the price history begins → no_entry_price.
  check(
    compute(prices, { ...base, ticker: "AAPL", eventDate: "2013-01-01", direction: "buy" }).status === "no_entry_price",
    "event before history → no_entry_price",
  );

  // --- Aggregation (aggregate.ts) — known-answer stats ---
  const aggEvents: ScoredEvent[] = [
    { group: "G", signed: { "1m": 0.1, "1d": 1 }, weight: 2 },
    { group: "G", signed: { "1m": -0.2, "1d": 2 }, weight: 1 },
    { group: "G", signed: { "1m": 0.3, "1d": 3 }, weight: 1 },
    { group: "G", signed: { "1m": null, "1d": 4 }, weight: 5 }, // 1m null → excluded at 1m only
  ];
  const g = aggregate(aggEvents)[0];
  check(g.nEvents === 4, `agg nEvents should be 4, got ${g.nEvents}`);
  check(g.lowConfidence === true, "agg group of 4 should be flagged low-confidence (< MIN_SAMPLE)");
  const m1 = g.horizons["1m"], d1 = g.horizons["1d"];
  check(m1.n === 3, `1m n should be 3 (one null excluded), got ${m1.n}`);
  check(APPROX(m1.mean!, 0.2 / 3), "1m mean should be 0.0666…");
  check(m1.median === 0.1, `1m median should be 0.10, got ${m1.median}`);
  check(APPROX(m1.std!, 0.2516611478, 1e-6), `1m sample std mismatch, got ${m1.std}`);
  check(APPROX(m1.hitRate!, 2 / 3), "1m hit rate should be 2/3");
  check(APPROX(m1.weightedMean!, 0.075), `1m weighted mean should be 0.075, got ${m1.weightedMean}`);
  check(d1.n === 4 && d1.median === 2.5, `1d median should be 2.5 (even count), got ${d1.median}`);
  check(APPROX(d1.weightedMean!, 3.0), `1d weighted mean should be 3.0, got ${d1.weightedMean}`);
  check(d1.hitRate === 1, "1d hit rate should be 100%");

  // --- Model B classification helpers ---
  check(tradeDirection("purchase") === "buy" && tradeDirection("sale") === "sell" && tradeDirection("sale_partial") === "sell" && tradeDirection("exchange") === null, "tradeDirection mapping");
  check(classifyUnsupported("Stock Option", "Microsoft - Common Stock (MSFT)") === "option", "stock option → option");
  check(classifyUnsupported("Municipal Security", "TX muni") === "fixed_income", "muni → fixed_income");
  check(classifyUnsupported(null, "Comcast Corp 1.95%31") === "fixed_income", "coupon name → fixed_income");
  check(classifyUnsupported("ST", "Adobe Inc. - Common Stock (ADBE)") === null, "common stock → supported");
  check(classifyUnsupported("Stock", "Apple Inc") === null, "plain stock → supported");
  check(amountMidpoint(1001, 15000) === 8000.5, "midpoint of a range");
  check(amountMidpoint(50000001, null) === 50000001, "open-ended range falls back to the bound");
  check(amountMidpoint(null, null) === null, "no amount → null weight");

  // --- Refinement stats (stats.ts) — known answers ---
  const fit = ols([1, 2, 3, 4], [2, 4, 6, 8]);
  check(!!fit && APPROX(fit.beta, 2) && APPROX(fit.alpha, 0), "OLS of y=2x → beta 2, alpha 0 (R5)");
  const rej = benjaminiHochberg([0.001, 0.04, 0.5, 0.9], 0.1);
  check(rej[0] === true && rej[1] === true && rej[2] === false && rej[3] === false, "Benjamini–Hochberg rejections (R4)");
  check(APPROX(shrink(0.1, 10, 0, 10), 0.05), "shrink 0.10 (n=10,k=10) toward 0 → 0.05 (R4)");
  const ciA = bootstrapMeanCI([0.01, 0.02, -0.01, 0.03, 0.0, 0.04], 500, 7);
  const ciB = bootstrapMeanCI([0.01, 0.02, -0.01, 0.03, 0.0, 0.04], 500, 7);
  check(ciA.lo === ciB.lo && ciA.hi === ciB.hi, "bootstrap is deterministic for a fixed seed (R3)");
  check(ciA.lo != null && ciA.mean != null && ciA.hi != null && ciA.lo <= ciA.mean && ciA.mean <= ciA.hi, "bootstrap CI brackets the mean (R3)");

  // --- Pre-event run-up (R2) on the fixture ---
  check(typeof preEventAbnormal("AAPL", "2023-06-22", prices) === "number", "run-up resolves on an in-window date (R2)");
  check(preEventAbnormal("AAPL", "2013-01-01", prices) === null, "run-up null before price history (R2)");

  // --- MA8 abnormal volume (fixture carries a Volume column) ---
  check(typeof abnormalVolume("AAPL", "2023-06-22", prices) === "number", "MA8: abnormal volume resolves with volume data");
  check(abnormalVolume("AAPL", "2013-01-01", prices) === null, "MA8: abnormal volume null before history");

  // --- Model A deterministic ticker extraction (never fabricate) ---
  const ex = buildExtractor();
  const ms = new Map(extractMentions("$AAPL is up and I like Tesla. $ZZZ too.", ex).map((m) => [m.ticker, m]));
  check(ms.get("AAPL")?.method === "cashtag" && ms.get("AAPL")?.confidence === 0.9, "$AAPL → cashtag, high confidence");
  check(ms.get("TSLA")?.method === "name", "Tesla → TSLA via curated alias");
  check(ms.get("ZZZ")?.confidence === 0.55, "unknown cashtag kept at low confidence, not promoted to known");
  check(extractMentions("the economy is strong this quarter", ex).length === 0, "no symbol/name → zero mentions (never fabricate)");

  // --- MA2 news-coincidence window (model-a.hadPriorNews) ---
  const nd = ["2026-05-01", "2026-06-01", "2026-06-05"];
  check(hadPriorNews(nd, "2026-06-06", 7) === true, "MA2: news 1–5d before statement → prior news");
  check(hadPriorNews(nd, "2026-06-06T12:00:00Z", 7) === true, "MA2: works with a timestamped statement");
  check(hadPriorNews(nd, "2026-06-20", 7) === false, "MA2: news outside the window → not prior");
  check(hadPriorNews([], "2026-06-06", 7) === false, "MA2: no news → not prior");
  check(hadPriorNews(["2026-06-10"], "2026-06-06", 7) === false, "MA2: news AFTER the statement → not prior");

  // --- MA1 sentiment (statements-sentiment) ---
  check(classifySentiment("very bullish here, strong buy, huge upside").label === "bullish", "MA1: bullish text");
  check(classifySentiment("overvalued bubble, I'm shorting it, will crash").label === "bearish", "MA1: bearish text");
  check(classifySentiment("not bullish at all").label === "bearish", "MA1: negation flips bullish→bearish");
  check(classifySentiment("the weather is nice today").label === "neutral", "MA1: no cue → neutral");
  // local context: each ticker scored from its own surroundings (kept far apart).
  const longTxt = "Bearish on $TSLA — overvalued, avoid, a bubble that will crash and collapse." + " ".repeat(220) + "Bullish on $AAPL — strong buy, undervalued, huge upside, accumulate.";
  check(sentimentForMention(longTxt, { ticker: "AAPL", company_name: null, method: "cashtag" }).label === "bullish", "MA1: local context → AAPL bullish");
  check(sentimentForMention(longTxt, { ticker: "TSLA", company_name: null, method: "cashtag" }).label === "bearish", "MA1: local context → TSLA bearish");

  // --- MA7 US-Eastern DST boundaries (engine close-cutoff) ---
  check(isUsEasternDst("2023-07-01") === true && isUsEasternDst("2023-01-15") === false, "MA7: summer DST / winter standard");
  check(isUsEasternDst("2023-03-12") === true && isUsEasternDst("2023-03-11") === false, "MA7: DST starts 2nd Sunday March (2023-03-12)");
  check(isUsEasternDst("2023-11-04") === true && isUsEasternDst("2023-11-05") === false, "MA7: DST ends 1st Sunday Nov (2023-11-05)");

  console.log("=".repeat(60));
  if (fails.length) {
    console.error(`SELF-TEST FAILED (${fails.length}):`);
    for (const f of fails) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED ✓  engine (entry anchoring, sign, abnormal math, every missing-data");
  console.log("   status) + aggregation stats (mean/median/std/hit/weighted) + Model B classifiers.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
