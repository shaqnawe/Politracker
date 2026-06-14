# PoliTracker — Project Status

_Snapshot: 2026-06-07_

Tracks U.S. Congress (House + Senate) stock trades disclosed under the STOCK Act and presents
per-member trading profiles — plus company context (SEC EDGAR + news) and the President's annual
OGE holdings — in a mobile app. All data comes straight from official sources; no third-party
trade API in between.

## At a glance

| Piece | State |
| --- | --- |
| **Server** (Node + TypeScript) | **Feature-complete:** text scrapers + OCR pipeline + enrichment agents (SEC EDGAR, news) + OGE holdings. `tsc` clean. |
| **Mobile** (Expo / React Native) | **v1 built + refreshed:** members list, member profile, trade rows, provisional/unverified OCR rows, company-context screen, OGE holdings view, dark + light themes, branded header, native iOS dev build. `tsc` clean. |
| **Live data** | **147 members · 972 filings · 7,847 trades** (5,134 text-scraped + 2,713 OCR) · **551 rows in `review_queue`** · **88 OGE holdings** (President). Enrichment: 796 companies, 76 financial datapoints, 12 insider trades, 24 news items, 3 AI company notes. |
| **Git** | Repo initialized on `main`, **0 commits** — everything still untracked. |
| **Tests** | No unit-test suite. The OCR eval harness (`ocr:eval` / `ocr:confidence`) is the regression check against hand-labeled fixtures. |

Server ≈ 5,900 lines of TypeScript across 48 files; mobile ≈ 1,600 across 14. Both type-check clean.

## Architecture

```
 Senate eFD ─┐  text path   (npm run scrape):     electronic / online PTRs ─► scrapers ─────────────────┐
             ├─►                                                                                          ├─► SQLite ─► REST API ─► Expo app
 House Clerk ┘  OCR path    (npm run scrape:ocr):  paper / scanned PTRs ─► preprocess ─► vision ─► gate ──┤
                                                                                       (flagged) ─► review_queue
 SEC EDGAR ──┐  agents      (npm run job -- <name>): Form 4 insiders + XBRL financials ─┐
 News RSS ───┤                                       news (RSS → LLM relevance/summary) ─┼─► SQLite ─► API ─► CompanyScreen
 OGE 278e ───┘                                       President holdings snapshot ────────┘
```

- **Senate** — Electronic Financial Disclosures (eFD): electronic PTRs as HTML tables; paper PTRs as scanned images (OCR path).
- **House** — Clerk Financial Disclosure annual index (ZIP) + per-filing PTR PDFs; online PTRs (DocID `2…`) have extractable text, scanned PTRs (DocID `8…`) go through OCR.
- **Enrichment (official, free)** — SEC EDGAR (Form 4 insider trades, XBRL companyfacts financials), free news RSS (LLM-summarized; links + summaries only), and the President's annual OGE Form 278e holdings.

## What's implemented (server)

### Scrapers (text) — `src/scrapers/`
- **`senate.ts`** — accepts the eFD usage agreement (CSRF + session cookie), pages the report-search JSON newest-first, parses each electronic PTR's HTML table. Also enumerates Senate *paper* PTRs as OCR candidates.
- **`house.ts`** — downloads the annual `YYYYFD.ZIP` index, parses periodic-transaction filings, extracts rows from flattened PDF text (anchors on `type-letter + two MM/DD/YYYY dates + amount`). Also enumerates *scanned* PTRs (DocID `8…`) as OCR candidates.
- **`run.ts`** — CLI runner. Flags: `--source`, `--max`, `--year`, `--start`, `--filer=<name>` (targeted backfill), `--ocr` / `--dry-run`, `--chunk` / `--chunk-spacing` (OCR chunking), `--redo=<provider>` (re-OCR existing filings, replacing rows). Incremental — skips already-ingested filings.

### OCR pipeline — `src/ocr/`
Covers scanned/paper PTRs behind `--ocr`: download → rasterize + preprocess → vision extract → validate → per-field confidence gate (0.85) → route to `trades` (`source='ocr'`) or `review_queue`.
- **`preprocess.ts`** — rasterize, orient, enhance, downscale to ≤1568px.
- **`providers/`** — pluggable vision backends: `claude.ts` (Anthropic API), `openai.ts` (gpt-4o), and **`claude-cli.ts`** (runs `claude -p` on a Claude **subscription** — no API credits; sonnet with thinking disabled).
- **`validate.ts`** — normalizes each row (reusing the text parsers), applies rules + the confidence gate. Dual-date sanity hardening; `toIsoDate` handles MM/DD/YY.
- **`chunked.ts`** — splits large filings into per-request page chunks, paces them under per-minute token limits, retries 429s, and **aborts fast on a billing/quota error** (no wasted spend).
- **`eval.ts` / `run-eval.ts` / `run-confidence.ts`** — score against hand-labeled fixtures; report the **silent-error rate** used to calibrate the gate.
- **`scripts/revalidate-review.ts`** — re-run validation over stored `review_queue` extractions and promote rows that now pass (e.g. after a parser fix) — no re-OCR.

### Enrichment agents — `src/agents/`
Deterministic collectors + LLM only for analysis, driven by a code orchestrator (`npm run job -- <name>`, idempotent):
- **`companies`** — ticker → CIK via SEC; **`insider`** — EDGAR Form 4 → `insider_trades`; **`financials`** — XBRL companyfacts → `company_financials` (revenue/net income/EPS/assets/buybacks); **`news`** — Google News RSS → `news_items` (links + titles); **`news-research`** — Haiku relevance/summary/event/sentiment; **`financials-review`** — LLM narrative + flags → `company_notes`.
- **`scheduler.ts` / `alerts.ts`** — in-process cron matcher (`npm run scheduler`) + failed/stale-job alerting.

### OGE holdings — `src/oge/`
The President files the annual **OGE Form 278e** (a holdings + income *snapshot* in ranges, not dated trades). `parse278e.ts` parses Schedule A; `ingest-trump.ts` downloads the filing and ingests the **public-market** holdings (stocks/ETFs/funds/Treasuries) for the President as an `executive`-chamber member. Stored in a separate `holdings` table — never synthetic trades.

### Storage — `src/db.ts`
SQLite (better-sqlite3, WAL): `members`, `filings`, `trades`, `review_queue`, `holdings`. OCR provenance columns (`source`, `ocr_provider`, `ocr_confidence`, `needs_review`). Atomic OCR ingest with a `replace` path for redo. `scripts/dedupe-members.ts` keyed member identity on chamber+name+**state** (not district) so redistricting no longer splits a person.

### REST API — `src/index.ts` + `src/api/` + `src/agents/api.ts`
| Endpoint | Description |
| --- | --- |
| `GET /api/health` · `/api/health/jobs` | row counts · agent-job health |
| `GET /api/stats` | top tickers + most active members |
| `GET /api/members` · `/api/members/:id` | members (incl. executive/holdings); profile + stats + trades + unverified OCR rows + holdings |
| `GET /api/members/:id/context` | company context for a member's tickers |
| `GET /api/companies/:ticker` | financials + insiders + news + AI note |
| `GET /api/trades?ticker=&chamber=&limit=&offset=` | recent trade feed |

Amounts are always the disclosed **range** (`amount_min`/`amount_max` + label), never exact.

## Mobile app — `mobile/`
- **`screens/MembersScreen`** — list sorted by activity, chamber filter, verified/unverified/holdings counts.
- **`screens/MemberScreen`** — profile: stats, top tickers (tap → company), trade history, an **Unverified · OCR-extracted** section, and a **Public holdings** section for executive filers.
- **`screens/CompanyScreen`** — financials table, insider activity, news, AI note.
- **`components/`** — `TradeRow`, `ProvisionalRow` (amber, unverified OCR), `HoldingRow` (annual snapshot), `Caveats`, `HeaderBrand` (monogram SVG).
- **`theme/`** — refined dark + light tokens, `useColorScheme()`-driven. Native iOS dev build exists (`com.politracker.mobile`).

## Data caveats (surfaced in-app)
- **45-day reporting lag** — nothing is real-time.
- **Amounts are ranges**, never exact.
- **OCR-sourced trades** are lower-trust: only rows clearing every rule + the confidence gate are verified; the rest are shown flagged as **unverified**. 551 rows currently sit in `review_queue`.
- **OGE holdings** are an annual snapshot of mostly-private assets; only public-market holdings are itemized.
- **Spouse/dependent-owned** trades are filed by the member but may not be theirs.

## What's not done yet
- **No git commits** — nothing tracked yet.
- **`party` is `null`** for all members — no scraper writes it (intended source: `unitedstates/congress-legislators`).
- **No returns/performance** data (ranges only, no price feed) and **no committee/conflict** data.
- **551 unverified OCR rows** remain in review (genuinely hard scans) — would need manual review or a second-model pass.
- **No unit-test suite** beyond the OCR eval harness.

## Suggested next steps
1. Make the initial git commit to capture the backend + mobile app.
2. Wire a `party` source (`congress-legislators`) at ingest.
3. Triage the `review_queue` (551 rows) / tune the gate via `npm run ocr:confidence`.
4. Expand OGE coverage (other executive filers; 278-T executive transaction reports, with careful per-filer attribution).
