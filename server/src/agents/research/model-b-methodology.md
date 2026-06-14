# Model B — Disclosed Congressional Trade Performance: Methodology

**This is correlation / event-study analysis. It is NOT investment advice, NOT a
trading signal, and NOT a claim that any member traded on inside information.**
It measures how stocks moved *after* members' disclosed transactions, relative to
the market — nothing more.

Code: `model-b.ts` (pipeline) · `returns.ts` (shared engine, see `returns-spec.md`)
· `aggregate.ts` (roll-ups). Run: `npm run research:model-b`.

---

## 1. Question

For each disclosed congressional trade, did the stock subsequently **out- or
under-perform the S&P 500**, in the direction the member traded? Aggregated per
member and per ticker: how often, by how much, and with what uncertainty?

## 2. Inputs

The existing `trades` table (Senate eFD + House Clerk, online + OCR). No new data
source except the **price layer** (`prices.ts`) — daily adjusted close per ticker
and for SPY — which is the one third-party dependency, isolated and cached.

**Eligibility / hygiene (excluded counts are reported every run):**
- `needs_review` provisional rows never enter (they live in `review_queue`, not
  `trades`). OCR-sourced rows that *passed* the gate **are** included but tagged
  `ocr`, and every report shows an **online-only robustness cut** beside the full
  set so you can see whether OCR data is moving the result.
- **Exchanges** (`tx_type='exchange'`, ~249) are dropped — no clean buy/sell
  direction.
- **Non-equities** — options, bonds/Treasuries/munis, mutual funds, crypto — are
  flagged and dropped (`classifyUnsupported`): the engine must never price an
  option off its underlying or a bond as a stock. Classification is best-effort
  over inconsistent `asset_type` codes + name patterns (coupon/maturity → bond);
  it **over-flags on purpose** (excluding is safe, mis-pricing is not).
- Trades with **no usable ticker** or a non-ISO date are dropped.

## 3. Per-trade return (the shared engine)

For each eligible trade we call `computeForwardReturns` with `entry='trade'`:
- **Anchor = the TRANSACTION date**, not the disclosure/filing date. Entry `t0`
  is the transaction day if it traded, else the next trading day; the member
  acted that day, so the same-day close is the right entry. (The ~45-day
  reporting lag means a *follower* could not have acted then — that's the
  disclosure-date variant proposed in §6, not the baseline.)
- **Forward abnormal return** at 1d / 1w / 1m / 3m (trading-day offsets on SPY's
  calendar): `abnormal = (stock return) − (SPY return)`. Market-adjusted,
  beta = 1.
- **Direction sign:** buy → `signed = abnormal`; **sell → `signed = −abnormal`**
  (a sale that dodges a drop is a *good* call). This sign flip is the thing that
  silently breaks a naive analysis if missed.
- **Missing data is never fabricated:** unresolved ticker, no entry price,
  delisting, thin-name gap, or too-recent (horizon past today) each resolve to
  `null` + an explicit status, and are simply absent from the stats.

## 4. Weighting — amounts are RANGES

Disclosures give a **range** ($1,001–$15,000, …), never an exact figure. So every
dollar-weighted number is an **estimate**: we weight by the range **midpoint**
and label it as such (`wtd mean*`). The **headline figures are equal-weighted**
(each trade counts once); the midpoint-weighted figures are shown alongside as a
"do bigger trades look different?" cut — never as exact position sizing.

## 5. Aggregation & uncertainty (`aggregate.ts`)

Per member and per ticker, for each horizon: **n**, mean, **median**,
**dispersion (std)**, and **hit rate** (% with positive signed return) — plus the
midpoint-weighted mean. Rules:
- **Never a bare average:** n and dispersion always shown.
- Groups with **n < 10** (`MIN_SAMPLE`) are flagged `⚠ low-n` — treat as
  unreliable; most individual members will be small-n.
- "Best/worst single trades" are shown for transparency but labelled **anecdotes,
  not evidence**.
- **Committee-level** aggregation is **not built** — the project has no committee
  data yet (noted in CLAUDE.md). It's a §6 proposal, not a silent omission.

## 6. Known weaknesses (read before trusting any number)

1. **Reverse causation / momentum.** Members often trade names *already* in the
   news and moving. Post-trade drift can be the tail of a move that *preceded*
   the trade, not a consequence of skill. The baseline does **not** separate
   these. (Mitigation proposed below: a pre-event run-up window + placebo.)
2. **Look-ahead / investability.** Transaction-date anchoring measures the
   member's timing, but the public only learns of the trade up to ~45 days later
   — so these returns are **not** what a follower could have captured.
3. **Overlapping windows.** Many trades cluster in time and name, so their
   1m/3m windows reuse the same price path. That **inflates apparent
   significance**; the std/hit-rate here are descriptive, not a valid test.
4. **Multiple comparisons.** With ~150 members, some will look "skilled" by pure
   chance. No correction is applied in the baseline.
5. **Single-factor model (beta = 1).** Abnormal return = stock − SPY assumes unit
   market beta and ignores size/sector/factor exposure. A high-beta name in a
   rising market looks "skilled" spuriously.
6. **Data quality.** OCR rows can carry **artifact tickers** (e.g. a stray
   `"THE"`); a format-valid artifact that happens to match a real symbol would
   mis-attribute. Hence the online-only cut. Asset classification is heuristic.
7. **Attribution.** ~Two-thirds of rows are spouse/joint/dependent-owned — the
   member files but may not have chosen the trade.
8. **Coverage / survivorship.** Only ingested filings; tickers absent from your
   price data drop out (not at random — delisted/foreign/thin names skew
   missing).
9. **Price-source dependency.** Results depend entirely on the adjusted-close
   series you load; vintage/quality matters and is recorded per symbol.

## 7. Refinements — **applied** (R1–R7, R9), beside the baseline

These are **implemented and reported** as variants next to the β=1 transaction-date
headline (which is unchanged). Every run shows them in `model-b-latest.md`:

- **R1 — Disclosure-date (investable) variant.** Returns also computed from the
  *filing* date with statement-style entry (next close), so we report both
  "member timing" and "what a follower could have traded." → `overall.disclosure`.
- **R2 — Pre-event run-up + placebo baseline.** A `[t0−21, t0]` pre-trade abnormal
  **run-up** (`preEventAbnormal`) shows how much each name had *already* moved; and
  a per-ticker **baseline drift** (mean forward abnormal over ~50 sampled dates) is
  netted out of each trade → `overall.baselineAdjusted` + the run-up summary.
- **R3 — Overlap-aware significance.** Percentile **bootstrap CI** on the mean,
  resampling **clusters** keyed by (ticker, month) so overlapping windows don't
  count as independent → `bootstrap`.
- **R4 — Multiple-comparison control.** Per-member two-sided p-value on the 1m
  mean, **Benjamini–Hochberg FDR** (q=0.1) across all members, and empirical-Bayes
  **shrinkage** toward the population mean → `byMember` (p1m / rejectedFDR / shrunk1m).
- **R5 — Market model.** Optional α/β estimated by OLS over `[t0−150, t0−30]`;
  `AR = R − (α·h + β·R_mkt)`, falling back to β=1 when the window is too sparse →
  `overall.marketModel`.
- **R6 — Owner split.** Aggregated by owner (self / spouse / joint / dependent) →
  `byOwner`.
- **R7 — Ticker validation.** Each ticker checked against the SEC-resolved company
  universe (`agents/companies`); a validated-only cut is reported →
  `overall.validated`. (Asset/option/bond detection also hardened in §2.)
- **R9 — Hypothetical "follow-the-Congress" cut.** Buys-only and sells-only
  aggregates as a clearly-labelled, **non-investable** proxy → `overall.buys/sells`.

**Deferred:**
- **R8 — Committee overlap.** Cannot be applied — the project has **no committee
  data** yet (see CLAUDE.md). The report prints an explicit deferral note rather
  than faking it. When committee data lands, aggregate by committee and flag
  trades in overseen sectors.

The verification of these (OLS, FDR, shrinkage, deterministic bootstrap, run-up)
is in `npm run research:selftest`.

## 8. Output

Per run: `trade_returns` (one row per trade, signed abnormal + status per
horizon) and a markdown/JSON data report under `server/data/reports/`. Every
surface repeats the disclaimer and the n / low-confidence flags.

> **Status:** pipeline + aggregation are built and unit-verified
> (`npm run research:selftest`). Real numbers populate once daily adjusted-close
> CSVs are loaded into `server/data/prices/` (see its README); until then a run
> reports coverage and notes that no trade resolved to a price.
