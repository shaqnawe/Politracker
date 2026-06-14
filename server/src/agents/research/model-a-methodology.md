# Model A — Public-Figure Statements vs Price Moves: Methodology

**This is correlation / event-study analysis. It is NOT investment advice, NOT a
trading signal, and NOT a claim that any figure moved a stock or had non-public
information.** It measures whether prices moved *after* public figures mentioned
a stock, relative to the market.

Code: `model-a.ts` · `statements-extract.ts` (mention extraction) · `returns.ts`
(shared engine) · `aggregate.ts` / `stats.ts`. Ingest: `npm run
research:ingest-statements -- --file=...`; run: `npm run research:model-a`.

---

## 1. Question

When a configured public figure makes a dated public statement mentioning a
stock, does that stock subsequently out-/under-perform the S&P 500? Rolled up per
figure and per ticker: how big is the move, how often is it up, with what
uncertainty?

## 2. Inputs — you supply the statements

Statements are **provided as data** (`research:ingest-statements --file=<json>`),
not scraped. No social-media/transcript scraper is built in: those platforms are
ToS/copyright-restricted, and the project's rule is official/free sources only.
This mirrors the price layer's "supply-the-data" choice — pluggable, so a
specific official feed (e.g. a .gov press-release RSS) can be added behind the
same interface later. Input schema: `fixtures/statements-sample.json`.

Stored: `figures` (the configurable watchlist), `statements` (figure, timestamp,
source, source_url, **verbatim** text), and `statement_mentions` (extracted
tickers). A statement is kept even if it mentions no ticker.

## 3. Ticker extraction — deterministic, never fabricated

`statements-extract.ts` emits a mention only when a concrete token is present:
1. **cashtag** `$AAPL` (confidence 0.9 if in the SEC universe, else 0.55),
2. **explicit** parenthesised symbol `(AAPL)` that is in the universe (0.85),
3. **company name** — a curated alias (`apple→AAPL`, 0.8) or a multi-word
   universe name (0.7).

Single bare common words are **not** matched as names (too many false positives —
they need a cashtag/explicit symbol). Every mention records its method +
confidence so the model can weight or filter. No LLM, no guessing: if nothing
matches, the statement has zero mentions.

## 4. Per-mention return (the shared engine)

`computeForwardReturns` with `entry='statement'`:
- **No look-ahead:** entry is the first close that occurs **strictly after** the
  statement. With a timestamp, before that day's close → that day, else next; with
  a date only → the next trading day. So we never credit a move that predated the
  statement being public.
- **Forward abnormal return** at 1d/1w/1m/3m vs SPY (market-adjusted).
- **UNSIGNED.** A statement has no buy/sell direction, so we report the move
  itself; "up%" is the share of mentions with a positive abnormal return. (Signing
  by sentiment is a proposed refinement, §7 — not applied by default.)
- Missing data → `null` + status, never fabricated.

## 5. Aggregation & uncertainty

Per figure / ticker / extraction-method: **n**, mean, median, dispersion, up%,
and a **confidence-weighted** mean (cashtags weigh more than name matches).
Groups with **n < 10** are flagged low-confidence. Most individual figures will be
small-n; treat single-figure numbers as anecdotes.

## 6. Applied refinements (shared machinery, reused from Model B)

- **R2 — pre-event run-up + baseline.** The **run-up** (abnormal return in the
  month *before* the statement) is the headline reverse-causation check — large
  positive run-up means figures talk about names already moving. A per-ticker
  baseline drift is netted out in the **baseline-adjusted** cut.
- **R3 — overlap-aware bootstrap CI**, clustering by (ticker, month).
- **R4 — FDR + shrinkage** across figures (Benjamini–Hochberg, q=0.1; shrink to
  the population mean). With many figures, raw "significant" results are expected
  by chance.
- **R5 — α/β market model** variant beside the beta=1 headline.
- **R7 — ticker validation** against the SEC company universe (validated-only cut).
- **MA1 — sentiment-signing.** Each mention gets a **deterministic lexicon** sentiment
  (`statements-sentiment.ts`, scored on the local context around the mention, with negation) at
  ingest; bullish → +abnormal, bearish → −abnormal, neutral excluded. Reported as a **signed cut +
  per-figure "directional accuracy" (right%)** beside the unsigned headline — so "the figure was
  directionally right" is separable from "the price just moved". Heuristic, not language
  understanding; an LLM classifier (cf. the news agent's sentiment) can swap in behind the same shape.
- **MA2 — news-coincidence control.** Each mention is split by whether its ticker was already in the
  collected news (`news_items`) within `RESEARCH_NEWS_WINDOW_DAYS` (default 7) before the statement:
  "already in news" vs "fresh" abnormal-return cuts, the most direct attack on reverse causation.
  Coverage is only as deep as the news agent (`npm run job -- news`) has accumulated — currently
  sparse, so the report states how many mentions were assessable vs "can't tell".
- **MA3 — de-duplication.** A first-mention-only cut that collapses repeat mentions of the same
  (figure, ticker) within `RESEARCH_DEDUP_WINDOW_DAYS` (default 5), to reduce overlap inflation.
- **MA4 — figure-type stratification.** Aggregates broken out by figure kind (executive / politician
  / pundit / …) — execs talking their own book differ from pundits.
- **MA5 — source/medium stratification.** Aggregates broken out by statement source (speech / social
  / interview / …). (Stratification, not an imposed weight — lets differences show without bias.)
- **MA6 — matched-date placebo.** For each mention's ticker, sample random dates' forward abnormal
  (the null) and **permutation-test** whether the actual mentions moved more than random days in the
  *same* tickers: reports actual vs placebo, **excess**, and an empirical p per horizon. The strongest
  reverse-causation control here (a small excess / large p ⇒ the move is just the stock's normal
  behaviour). Deterministic (per-ticker seeded sampling).
- **MA7 — intraday precision.** The engine's "first close after the statement" cutoff is now
  **DST-aware** (16:00 ET = 20:00 UTC in summer, 21:00 UTC in winter) instead of a fixed 20:00 UTC, so
  a timestamped statement near the close anchors to the correct trading day year-round.
- **MA8 — corroborating signal: abnormal volume.** Mean trading volume on the statement day vs the
  trailing month (`abnormalVolume`), a second axis beyond price ("did the market notice?"). Needs a
  `Volume` column in the price data (CSV or the Yahoo provider); the report says so when it's absent.

## 7. Known weaknesses (read before trusting any number)

1. **Reverse causation — the dominant problem.** Figures overwhelmingly mention
   stocks **already in the news and moving**. Post-statement drift is largely the
   continuation of a pre-existing move, not an effect of the statement. The run-up
   and baseline-adjusted cuts expose this but do not fully remove it.
2. **Selection / coverage bias.** Results depend entirely on *which* statements
   you ingest. Cherry-picked or incomplete statement sets produce biased numbers;
   there's no comprehensive, unbiased statement corpus here.
3. **Extraction precision.** Name matching can mis-hit; cashtags for non-universe
   symbols are kept at low confidence. Use the cashtag-only cut as a check.
4. **Look-ahead vs reality.** Even with next-close entry, a *follower* may not
   realistically transact at that close.
5. **Overlapping windows & multiple comparisons** — same caveats as Model B.
6. **Unsigned ambiguity.** A statement can be bullish or bearish; an unsigned
   "the price moved" conflates "they were right" with "they moved it" with "it was
   already moving."
7. **No causal claim.** Correlation only; confounded by news, earnings, and
   market-wide factors.

## 8. Proposed refinements — **for your approval (not applied)**

Model-A-specific candidates beyond the shared R2–R5/R7 above. Tell me which to add:

- **MA1 — Sentiment-signed returns.** ✅ **APPLIED** (see §6; deterministic lexicon, LLM swap-in
  possible).
- **MA2 — News-coincidence control.** ✅ **APPLIED** (see §6).
- **MA3 — First-mention-only / de-duplication.** ✅ **APPLIED** (see §6).
- **MA4 — Figure-type stratification.** ✅ **APPLIED** (see §6).
- **MA5 — Source/medium stratification.** ✅ **APPLIED** (see §6).
- **MA6 — Matched-date placebo.** ✅ **APPLIED** (see §6).
- **MA7 — Intraday precision.** ✅ **APPLIED** (see §6).
- **MA8 — Corroborating signals.** ✅ **APPLIED** (abnormal volume; see §6). Volatility/options-flow
  remain future extensions.

## 9. Output

Per run: `statement_returns` (one row per mention) + a markdown/JSON report under
`server/data/reports/`. Every surface repeats the disclaimer, the n, and the
low-confidence flags.

> **Status:** pipeline, extraction, and refinements are built and verified
> (`npm run research:selftest`). Real numbers populate once you (a) ingest
> statements and (b) load adjusted-close CSVs into `server/data/prices/`.
