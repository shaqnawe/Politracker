# PoliTracker — Project Status

_Snapshot: 2026-06-19_

Tracks U.S. Congress (House + Senate) stock trades disclosed under the STOCK Act and presents
per-member trading profiles — plus company context (SEC EDGAR + news), the President's annual
OGE holdings, and an event-study **research engine** — in a mobile app. All data comes straight
from official sources; no third-party trade API in between.

## At a glance

| Piece | State |
| --- | --- |
| **Server** (Node + TypeScript) | **Feature-complete:** text scrapers + OCR pipeline + enrichment agents (SEC EDGAR, news) + OGE holdings + **research/analysis engine (Model A/B)**. `tsc` clean. |
| **Mobile** (Expo / React Native) | **v1 built + refreshed:** **4-tab shell** (Members · Feed · Explore · Watchlist), member profile, company/ticker view ("who traded it"), watchlist with local persistence, provisional/unverified OCR rows, OGE holdings view, dark + light themes, branded header, native iOS dev build. `tsc` clean. |
| **Live data** | **147 members · 972 filings · 7,847 trades** (5,134 online + 2,713 OCR) · **742 rows in `review_queue`** · **88 OGE holdings** (President). Enrichment: 796 companies, 76 financial datapoints, 12 insider trades, 24 news items, 3 AI company notes. |
| **Research data** | Engine + schema built; **tables empty (0 rows)** — no price feed loaded yet, so Model A/B produce no numbers. |
| **Git** | On `main`, **1 commit** (initial commit made; working tree has since moved on). |
| **Tests** | No unit-test suite. Regression checks: the OCR eval harness (`ocr:eval` / `ocr:confidence`) against hand-labeled fixtures, and `research:selftest` (deterministic engine/stats/extraction tests, no network or DB writes). |

Server ≈ 9,050 lines of TypeScript across 63 files; mobile ≈ 2,420 across 21 files. Both type-check clean.

## Architecture

```
 Senate eFD ─┐  text path   (npm run scrape):     electronic / online PTRs ─► scrapers ─────────────────┐
             ├─►                                                                                          ├─► SQLite ─► REST API ─► Expo app
 House Clerk ┘  OCR path    (npm run scrape:ocr):  paper / scanned PTRs ─► preprocess ─► vision ─► gate ──┤
                                                                                       (flagged) ─► review_queue
 SEC EDGAR ──┐  agents      (npm run job -- <name>): Form 4 insiders + XBRL financials ─┐
 News RSS ───┤                                       news (RSS → LLM relevance/summary) ─┼─► SQLite ─► API ─► CompanyScreen
 OGE 278e ───┘                                       President holdings snapshot ────────┘
 price CSVs ──►  research   (npm run research:*):    price_bars cache ─► returns engine ─► Model A (statements)
                                                                                          └► Model B (trades)  ─► methodology reports
```

- **Senate** — Electronic Financial Disclosures (eFD): electronic PTRs as HTML tables; paper PTRs as scanned images (OCR path).
- **House** — Clerk Financial Disclosure annual index (ZIP) + per-filing PTR PDFs; online PTRs (DocID `2…`) have extractable text, scanned PTRs (DocID `8…`) go through OCR.
- **Enrichment (official, free)** — SEC EDGAR (Form 4 insider trades, XBRL companyfacts financials), free news RSS (LLM-summarized; links + summaries only), and the President's annual OGE Form 278e holdings.
- **Research (correlation analysis, not advice)** — a shared forward-return engine + two event-study models on top of it. The **one** non-official dependency is a price feed, which you supply (CSV); no official/free daily-price source exists.

## What's implemented (server)

### Scrapers (text) — `src/scrapers/`
- **`senate.ts`** — accepts the eFD usage agreement (CSRF + session cookie), pages the report-search JSON newest-first, parses each electronic PTR's HTML table. Also enumerates Senate *paper* PTRs as OCR candidates.
- **`house.ts`** — downloads the annual `YYYYFD.ZIP` index, parses periodic-transaction filings, extracts rows from flattened PDF text (anchors on `type-letter + two MM/DD/YYYY dates + amount`). Also enumerates *scanned* PTRs (DocID `8…`) as OCR candidates.
- **`run.ts`** — CLI runner. Flags: `--source`, `--max`, `--year`, `--start`, `--filer=<name>` (targeted backfill), `--ocr` / `--dry-run`, `--chunk` / `--chunk-spacing` (OCR chunking), `--redo=<provider>` (re-OCR existing filings, replacing rows). Incremental — skips already-ingested filings.

### OCR pipeline — `src/ocr/`
Covers scanned/paper PTRs behind `--ocr`: download → rasterize + preprocess → vision extract → validate → per-field confidence gate (0.85) → route to `trades` (`source='ocr'`) or `review_queue`.
- **`preprocess.ts`** — rasterize, orient, enhance, downscale to ≤1568px.
- **`providers/`** — pluggable vision backends: `claude.ts` (Anthropic API), `openai.ts` (gpt-4o), and **`claude-cli.ts`** (runs `claude -p` on a Claude **subscription** — no API credits; sonnet with thinking disabled).
- **`validate.ts`** — normalizes each row (reusing the text parsers), applies rules + the confidence gate. Dual-date sanity hardening; `toIsoDate` handles MM/DD/YY. Nulls OCR **artifact tickers** (THE/AND/INC/CORP/ETF…) rather than emitting a fake symbol.
- **`chunked.ts`** — splits large filings into per-request page chunks, paces them under per-minute token limits, retries 429s, and **aborts fast on a billing/quota error** (no wasted spend).
- **`eval.ts` / `run-eval.ts` / `run-confidence.ts`** — score against hand-labeled fixtures; report the **silent-error rate** used to calibrate the gate.
- **`scripts/revalidate-review.ts`** — re-run validation over stored `review_queue` extractions and promote rows that now pass (e.g. after a parser fix) — no re-OCR.

### Enrichment agents — `src/agents/`
Deterministic collectors + LLM only for analysis, driven by a code orchestrator (`npm run job -- <name>`, idempotent):
- **`companies`** — ticker → CIK via SEC; **`insider`** — EDGAR Form 4 → `insider_trades`; **`financials`** — XBRL companyfacts → `company_financials` (revenue/net income/EPS/assets/buybacks); **`news`** — Google News RSS → `news_items` (links + titles); **`news-research`** — Haiku relevance/summary/event/sentiment; **`financials-review`** — LLM narrative + flags → `company_notes`.
- **`scheduler.ts` / `alerts.ts`** — in-process cron matcher (`npm run scheduler`) + failed/stale-job alerting.

### Research / analysis models — `src/agents/research/`
Two event-study models on one shared forward-return engine. **Everything here is correlation analysis — not a trading signal, not financial advice.** Real numbers require a price feed you supply.
- **`returns.ts`** — the engine. Forward **abnormal** return vs the S&P 500 (SPY) at 1d/1w/1m/3m, trading-day horizons, no-look-ahead entry anchoring, buy/sell sign, `null`+status on missing data, optional α/β market model, pre-event run-up, abnormal volume, DST-aware market close. Spec: `returns-spec.md`.
- **`prices.ts`** + **`db.ts` (`price_bars`)** — pluggable price provider behind a local cache. Default `csv` (you supply files in `data/prices/`); `yahoo` fallback (fragile). `import "../db.js"` side-effect fixes schema init order.
- **`aggregate.ts`** / **`stats.ts`** — per-group roll-up (n, mean, median, std, hit rate, weighted mean, low-n flag); seeded bootstrap CIs, Benjamini–Hochberg FDR, shrinkage, OLS.
- **Model B** (`model-b.ts`) — how members' disclosed trades performed, from the **transaction date**, signed by direction, weighted by amount-range midpoint (estimate); excludes/flags `needs_review` OCR rows; unsupported-asset classifier (options/bonds/crypto). Refinements R1–R7, R9 applied (R8/committee deferred — no data). Docs: `model-b-methodology.md`.
- **Model A** (`model-a.ts`) — whether public figures' dated statements about stocks precede price moves; statements supplied as JSON, tickers extracted **deterministically** (`statements-extract.ts`, never fabricated), sentiment signed by a local lexicon (`statements-sentiment.ts`); prior-news guard, per-ticker placebo pool, dedup, by-figure-kind / by-source splits. Refinements MA1–MA8 applied. Docs: `model-a-methodology.md`.
- **Commands** — `research:selftest` (deterministic tests), `research:import-prices` (load CSVs), `research:model-b`, `research:ingest-statements`, `research:model-a`.
- **State:** schema migrated, engine + self-tests green, but every research table is **0 rows** — waiting on a price feed.

### OGE holdings — `src/oge/`
The President files the annual **OGE Form 278e** (a holdings + income *snapshot* in ranges, not dated trades). `parse278e.ts` parses Schedule A; `ingest-trump.ts` downloads the filing and ingests the **public-market** holdings (stocks/ETFs/funds/Treasuries) for the President as an `executive`-chamber member. Stored in a separate `holdings` table — never synthetic trades.

### Storage — `src/db.ts`
SQLite (better-sqlite3, WAL): `members`, `filings`, `trades`, `review_queue`, `holdings`, plus enrichment (`companies`, `company_financials`, `insider_trades`, `news_items`, `company_notes`) and research (`price_bars`, `price_symbols`, `trade_returns`, `figures`, `statements`, `statement_mentions`, `statement_returns`). OCR provenance columns (`source`, `ocr_provider`, `ocr_confidence`, `needs_review`). Atomic OCR ingest with a `replace` path for redo. `scripts/dedupe-members.ts` keyed member identity on chamber+name+**state** (not district) so redistricting no longer splits a person. `scripts/clean-tickers.ts` nulls OCR artifact tickers already in `trades`.

### REST API — `src/index.ts` + `src/api/` + `src/agents/api.ts`
| Endpoint | Description |
| --- | --- |
| `GET /api/health` · `/api/health/jobs` | row counts · agent-job health |
| `GET /api/stats` | top tickers + most active members |
| `GET /api/members` · `/api/members/:id` | members (incl. executive/holdings); profile + stats + trades + unverified OCR rows + holdings |
| `GET /api/members/:id/context` | company context for a member's tickers |
| `GET /api/companies/:ticker` | financials + insiders + news + AI note |
| `GET /api/trades?ticker=&chamber=&limit=&offset=` | recent trade feed (mixes online + OCR; paginated, no total-count) |

Amounts are always the disclosed **range** (`amount_min`/`amount_max` + label), never exact.

## Mobile app — `mobile/`
Four bottom tabs under a shared native stack (`Member` / `Company` detail pushed from any tab):
- **`screens/MembersScreen`** (tab) — list sorted by activity, chamber filter, verified/unverified/holdings counts.
- **`screens/FeedScreen`** (tab) — paginated cross-chamber disclosure feed (`/api/trades`), All/Senate/House filter, rows tap → member.
- **`screens/ExploreScreen`** (tab) — most-active-members + most-traded-tickers leaderboards, plus a ticker lookup box → company view.
- **`screens/WatchlistScreen`** (tab) — followed members + companies, NEW-trade badge, local persistence.
- **`screens/MemberScreen`** — profile: stats, top tickers (tap → company), trade history, an **Unverified · OCR-extracted** section, and a **Public holdings** section for executive filers.
- **`screens/CompanyScreen`** — financials table, insider activity, news, AI note, **plus "Congressional trades" (who in Congress traded this ticker)** — renders even when company context 404s.
- **`components/`** — `TradeRow` (shared by profile + feed + ticker view), `ProvisionalRow` (amber, unverified OCR), `HoldingRow` (annual snapshot), `Caveats` (context-aware: ranking / feed / company variants), `WatchButton` (★ header toggle), `HeaderBrand` (monogram SVG). Watchlist state via a `WatchlistProvider` (AsyncStorage).
- **`theme/`** — refined dark + light tokens, `useColorScheme()`-driven. Native iOS dev build exists (`com.politracker.mobile`).

## Data caveats (surfaced in-app)
- **45-day reporting lag** — nothing is real-time.
- **Amounts are ranges**, never exact.
- **OCR-sourced trades** are lower-trust: only rows clearing every rule + the confidence gate are verified; the rest are shown flagged as **unverified**. 742 rows currently sit in `review_queue`. The `/api/trades` feed mixes online + OCR trades without marking each row.
- **Coverage is partial** — a default scrape ingests only machine-readable filings; Senate paper / House scanned PTRs need the opt-in OCR path. "Most active" / ranking views say they reflect only filings ingested so far.
- **OGE holdings** are an annual snapshot of mostly-private assets; only public-market holdings are itemized.
- **Spouse/dependent-owned** trades are filed by the member but may not be theirs.
- **Research = correlation, not advice** — and it produces nothing until a price feed is loaded.

## What's not done yet
- **No price feed loaded** — the research engine (Model A/B) is built and self-tests pass, but every research table is empty, so there are no returns/performance numbers and no returns UI. Needs a supplied price source (e.g. Tiingo, or CSVs).
- **`party` is `null`** for all members — no scraper writes it (intended source: `unitedstates/congress-legislators`), so the UI shows no D/R/I tags.
- **No committee/conflict** data — the amber conflict-badge pattern is waiting on a source.
- **742 unverified OCR rows** remain in review (genuinely hard scans) — would need manual review, gate tuning, or a second-model pass.
- **No unit-test suite** beyond the OCR eval harness and `research:selftest`.
- **Model A has no statements loaded** — ingestion path exists, but no real transcripts/social statements have been supplied.

## Suggested next steps
1. **Wire a price source** (Tiingo or supplied CSVs) → light up Model A/B numbers and add a trade-performance / statement-signal surface to the app. Biggest single unlock.
2. Wire a `party` source (`congress-legislators`) at ingest.
3. Triage the `review_queue` (742 rows) / tune the gate via `npm run ocr:confidence`.
4. Expand OGE coverage (other executive filers; 278-T executive transaction reports, with careful per-filer attribution).
5. Ingest real statements for Model A once a figure list + sources are chosen.
