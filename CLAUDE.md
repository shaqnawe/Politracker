# PoliTracker — Project Memory

U.S. Congress (House + Senate) STOCK Act trade tracker. Scrapes official
disclosures → SQLite → REST API → Expo mobile app. No third-party data API
in between; all data comes from Senate eFD and the House Clerk index.

## Stack
- **Server** — Node + TypeScript, better-sqlite3 (WAL mode), REST. Source in
  `server/src/` (`scrapers/`, `ocr/`, `db.ts`, `util/`, `api/`, `index.ts`).
  Keep `tsc` clean. Scrape with `npm run scrape` (text PTRs) or
  `npm run scrape:ocr` (scanned/paper PTRs — see "OCR pipeline" below).
- **Mobile** — Expo / React Native + TypeScript, in `mobile/`. v1 screens
  are built under `mobile/src/`: members list, member profile, trade rows,
  the data-caveat banner, and dark + light theming.

## API contract — build against what exists
- `GET /api/health` — row counts (members / filings / trades)
- `GET /api/stats` — top tickers + most active members
- `GET /api/members` — members with ≥1 disclosed trade, sorted by activity
- `GET /api/members/:id` — profile + stats + top tickers + recent trades (paginated)
- `GET /api/trades?ticker=&chamber=&limit=&offset=` — recent trade feed

Pagination is `limit` / `offset` only — there is **no total-count** in
responses, so infer "end of list" from a short/empty page.

## OCR pipeline (scanned / paper PTRs)
The filings the text scrapers can't read — Senate *paper* PTRs and House
*scanned* PTRs (DocID starting `8…`) — are filled by an opt-in OCR path in
`server/src/ocr/`, wired into the scrape runner behind `--ocr`:

  download → rasterize + preprocess → vision extract (Claude or OpenAI) →
  validate → confidence gate → route to `trades` or `review_queue`.

- Run it with `npm run scrape:ocr`; needs `ANTHROPIC_API_KEY` or
  `OPENAI_API_KEY` (`OCR_PROVIDER` chooses between them). Vision calls cost
  money, so `npm run scrape:ocr:dry` lists candidate filings with no download
  or API spend.
- OCR trades are lower-trust: tagged `source='ocr'` with an `ocr_confidence`
  (scraped rows default to `source='online'`). Only rows that clear every
  validation rule **and** the per-field confidence threshold reach `trades`;
  anything flagged — plus filing-level problems — lands in the `review_queue`
  table with the raw extraction + reasons for a human.
- The threshold is calibrated, not guessed: `npm run ocr:eval` scores
  extraction against hand-labeled fixtures (`server/src/ocr/labels/` +
  `fixtures/`), and `npm run ocr:confidence` cross-checks the real gate
  against ground truth to report the **silent-error rate** — confident-but-
  wrong rows that would auto-ingest, the number the threshold minimizes.

## Styling conventions
- All colors and fonts come from the `design-system` skill (`theme.ts`).
  **Never hardcode hex in components.**
- Color semantics are FIXED: **green = buy / gain, red = sell / loss**;
  amber = flags / warnings; blue = links / info.
- Every number, ticker, dollar amount, and percentage uses JetBrains Mono
  with `fontVariant: ['tabular-nums']` so columns align.
- Dark is the default theme; light is selected via `useColorScheme()`.
  Test components in both.

## Data caveats — ALWAYS surface these in the UI
- **45-day reporting lag** — nothing is real-time.
- **Amounts are RANGES** ($1,001–$15,000), never exact figures.
- **Coverage is partial** — a default `npm run scrape` ingests only
  machine-readable filings (Senate electronic + House online PTRs). Senate
  paper and House scanned PTRs are covered only by the opt-in OCR path
  (`npm run scrape:ocr`), so unless that has been run some members' trades
  may be missing entirely. Any "most active" / ranking view must still say it
  reflects only the filings ingested so far, and the `/api/trades` feed mixes
  online and OCR-sourced trades without marking which is which.
- **Spouse-owned trades** — the member files the disclosure but may not be
  the one trading.

## Not available yet — do NOT build UI around these
- `party` is always `null` — the column exists and the API reads it, but no
  scraper writes it. Intended fix: static lookup from the
  `unitedstates/congress-legislators` dataset, matched at ingest.
- No returns / performance data (ranges only, no price feed) → no
  "return vs S&P 500" screens.
- No committee data → no conflict-of-interest badges yet.
- **Agents / enrichment collectors are designed, not built** — only
  `server/src/agents/ARCHITECTURE.md` exists (disclosure + OGE collector,
  SEC EDGAR / Form 4 collector, research agent, ticker universe,
  orchestrator). No agent code yet, so no EDGAR, OGE-holdings, or
  news-enrichment data.

## Working order
Server v1 is feature-complete (scrapers + OCR + REST API) and the mobile v1
screens are built; a local DB (`server/data/politracker.db`) has already been
populated by at least one scrape. The repo still has **0 commits**, so next
up: make the first commit, wire a `party` source, and start on the agents
collectors. Re-run `npm run scrape` (optionally `npm run scrape:ocr`) to
refresh data.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
