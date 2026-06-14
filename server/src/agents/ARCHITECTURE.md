# PoliTracker — Agents & Data-Collection Architecture (design)

Status: **design only** (no code yet). Build **after** the OCR pipeline (ocr STEP 3–8)
is finished. This documents the decided shape so we build to a plan.

## Goal

Around the core dataset (politician STOCK Act trades), automatically gather and surface
*context* for the tickers politicians trade: corporate insider activity, company
financials, and relevant news — so a member/stock view can answer "they bought X — what
are insiders doing, how is the company doing, what's the news?"

## Decided principles

- **Sources:** Congress (Senate eFD + House Clerk), **OGE** (executive-branch / presidential
  disclosures), **SEC EDGAR** (insider Form 4 + XBRL financials, incl. buybacks), and
  **free per-publisher RSS** for news. All are official/free except RSS. **No paid data
  APIs, no social channels.** EDGAR + OGE fit the project's "official sources" rule; RSS is
  the pragmatic, low-ToS-risk exception (we store **links + short summaries, never full text**).
- **Deterministic collectors, LLM only for analysis.** Data collection is plain,
  reliable, free code. The LLM (Claude/OpenAI keys already in `.env`) is reserved for
  fuzzy work: news relevance/summaries and financial-narrative review.
- **Orchestration is code, not an LLM "master agent"** (see Decisions).
- **Reuse** the existing building blocks: `util/http.ts` (rate-limit + retry), `db.ts`
  atomic-transaction ingest, the incremental/cron-safe pattern from `scrapers/run.ts`,
  and a provider-adapter pattern (like the OCR adapters) for swapping LLM backends.

## Components (5 requested → 2 collectors + 1 analysis agent + 1 code orchestrator)

| # | Component | Type | Source | Cadence |
|---|-----------|------|--------|---------|
| 1 | **Disclosure collector** | deterministic | Senate eFD + House Clerk (+ OCR path) + **OGE** (President/exec) | daily, weekday AM · OGE annually |
| 2 | **EDGAR collector** | deterministic | SEC EDGAR (Form 4 + XBRL facts) | Form 4 daily · financials weekly |
| 3 | **Research agent** | LLM | collected financials + free RSS | news a few×/day · summaries on new data |
| 4 | **Orchestrator** | code | (internal) | scheduler + hourly health check |

### 1. Disclosure collector  *(your "new gov filings" agent)*
The existing `scrapers/run.ts` on a schedule — already incremental/cron-safe. No "typical
day": House index regenerates ~daily (early ET), Senate is continuous; all carry a 30–45-day
lag, so **once per weekday morning** is the right cadence (the job logs first-seen times so
we can confirm the real pattern). Adds the OCR path for scanned filings once that's built.

**Executive branch / President (e.g. Trump) — via OGE.** It *is* public, but it's a
**different shape** and must not be forced into the congressional trade feed:
- **Form & cadence:** the President/VP and senior officials file the **annual OGE Form 278e**
  (a holdings + income-range *snapshot*), **not** the 45-day STOCK Act PTRs Congress files.
  So it refreshes ~yearly, not as a stream of dated buy/sell transactions.
- **Content:** mostly **private entities** (the Trump Organization LLCs, licensing, crypto
  ventures) with **few public tickers** (e.g. DJT / Trump Media). Amounts are **ranges**,
  like the rest of the app.
- **Source:** OGE public financial-disclosure database (`oge.gov`; exact search/download
  endpoint to confirm at build — reachability verified, deep link TBD). Official → fits the rule.
- **Data model:** store as a separate kind — `disclosures`/`holdings` rows tied to the
  member, flagged `report_type='annual_278e'`, **not** synthetic `trades`. The member can
  exist with holdings + zero PTR-style trades.
- **UI framing:** label it clearly as an **annual holdings snapshot**, not real-time trades,
  and surface that most assets are private/non-public-market — otherwise it misleads.

### 2. EDGAR collector  *(your "insider/company buys" + "financials" agents, merged)*
Both come from the same official source, so they are **one collector** scoped to the
**ticker universe** (tickers that appear in politician trades).
- **ticker → CIK** via `sec.gov/files/company_tickers.json` → `companies` table.
- **Insider trades:** SEC **Form 4** (ownership XML) per company → insider name/title,
  transaction code (P/S), shares, price, value, date. (Answers "are insiders buying/selling
  the same stocks?")
- **Financials + buybacks:** `data.sec.gov/api/xbrl/companyfacts/CIK…json` — standardized
  concepts (revenue, net income, EPS, assets, and `PaymentsForRepurchaseOfCommonStock` for
  **buybacks** — structured, no narrative parsing needed in v1).
- SEC etiquette: descriptive User-Agent, ≤10 req/s — handled by `HttpClient`.

### 3. Research agent (LLM)  *(your "news/publications" + "financials review", merged)*
One agent, two tasks, run only over the ticker universe and only on **new** data:
- **News (free RSS):** curated free feeds — SEC press releases, company IR RSS, and
  **Google News RSS** queries per ticker/member (free). Collect items → LLM **filters for
  relevance**, **summarizes**, tags **event type + sentiment** → `news_items` (link +
  summary only).
- **Financials review:** LLM turns the XBRL metrics/trends into a short narrative +
  structured flags (e.g., declining revenue, large buyback, margin shift) → `company_notes`.
- **Cost controls:** cheap model (Haiku) for relevance filtering, stronger model for
  summaries; cache by content hash; only (re)summarize when new filings/news arrive; batch.

### 4. Orchestrator (code, not an LLM)
A `jobs` registry + scheduler + health, **not** a reasoning agent:
- Each job: name, cron schedule, enabled, last_run, last_status, last_error, rows_added,
  duration → `jobs` / `job_runs` tables.
- Trigger via in-process `node-cron` **or** OS cron calling `npm run job:<name>` (jobs are
  idempotent/incremental, so either works — same philosophy as `run.ts`).
- Health: `GET /api/health/jobs` shows each job's freshness; **alert** (log/webhook) when a
  job fails or goes stale (e.g., disclosures not refreshed in >36h).

## The ticker universe (the join that bounds scope)
Everything keys off the tickers/members already in our DB:
`disclosures → tickers → (EDGAR insider + financials) + (news per ticker/member)`.
This keeps cost bounded and every fetch relevant to the app's purpose.

## Data model additions (sketch — mirrors existing snake_case + atomic ingest)
- `companies(ticker PK, cik, name, last_financials_at)`
- `insider_trades(id, ticker, insider_name, insider_title, tx_type, tx_date, shares, price, value, source_url, scraped_at)`
- `company_financials(id, ticker, fiscal_period, concept, value, unit, filed, source_url)`
- `news_items(id, ticker, member_id, source, title, url, published_at, summary, event_type, sentiment, model, created_at)`
- `company_notes(id, ticker, kind, body, flags_json, model, created_at)`
- `jobs(name PK, schedule, enabled)` · `job_runs(id, job, started, finished, status, rows_added, error)`

All writes are single atomic transactions; all collectors skip already-seen rows.

## API additions (so the app can surface context)
- `GET /api/companies/:ticker` — profile: financials, buybacks, recent insider trades, news.
- `GET /api/members/:id/context` — for each ticker the member traded: insider activity +
  latest financial flags + top news.
- `GET /api/health/jobs` — orchestrator status.

UI keeps the existing caveats culture (ranges, 45-day lag, partial coverage) and adds:
insider data is also lagged/disclosure-based; news is third-party (linked, summarized).

## Build phases (after OCR)
1. `companies` + ticker→CIK resolver; `jobs`/`job_runs` + orchestrator skeleton + health endpoint.
2. EDGAR collector — Form 4 (insider trades).
3. EDGAR collector — XBRL financials + buybacks.
4. RSS collector (raw items) → then LLM relevance/summary (research agent, news).
5. LLM financial-review notes (research agent, financials).
6. API endpoints + app surfacing.
7. Wire all jobs into the scheduler; alerting.

## Risks / open questions
- **RSS coverage is thin** vs paid news; Google News RSS helps but is best-effort. Acceptable
  given the "free only" decision; revisit if coverage is inadequate.
- **ticker→CIK** misses for funds/options/odd symbols → flag, don't guess (same ethos as OCR).
- **LLM cost** scales with ticker universe × news volume → strict "new-data-only" + caching.
- **Copyright/ToS:** store summaries + links only, never full article text.

## Decisions log
- **5 → 3 + orchestrator:** insider + financials share EDGAR → one collector; news +
  financial-review share the LLM → one research agent.
- **No LLM "master agent":** the work is scheduled + deterministic; "is it working" is a
  monitoring problem (job registry + health + alerts) — cheaper, debuggable, and reliable.
  An LLM orchestrator would add latency, cost, and nondeterminism for no real benefit. LLM
  stays on the fuzzy tasks only.
- **Cadence:** daily (weekday) disclosures + Form 4; weekly financials; news a few×/day;
  health hourly. Real-time is pointless under the 45-day disclosure lag.
