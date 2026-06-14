# PoliTracker — server

Node + TypeScript backend that scrapes official Congressional financial disclosures,
normalizes them into SQLite, and serves a small REST API.

## Setup

```bash
npm install
npm run scrape            # scrape Senate + House into data/politracker.db
npm run dev               # start API at http://localhost:4000 (auto-reload)
```

Scrape options:

```bash
npm run scrape -- --source=senate --max=50 --start=01/01/2024
npm run scrape -- --source=house  --max=50 --year=2024
```

The scraper is incremental — filings already in the DB are skipped, so it is safe to
re-run (e.g. on a cron) to pick up new disclosures.

## Data flow

```
Senate eFD  ──(agreement → JSON list → HTML PTR tables)──┐
                                                          ├─► normalize ─► SQLite
House Clerk ──(annual ZIP index → per-PTR PDF text)──────┘
```

- `src/scrapers/senate.ts` — accepts the eFD usage agreement, pages the report-search
  JSON endpoint, and parses each electronic PTR's HTML table.
- `src/scrapers/house.ts` — downloads the annual disclosure index ZIP, then extracts text
  from each online-filed PTR PDF and parses the transaction rows.
- `src/db.ts` — schema + atomic ingest (`members`, `filings`, `trades`).

Scanned/paper filings are skipped in v1 (they need OCR).

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | row counts |
| `GET /api/stats` | top tickers + most active members |
| `GET /api/members` | members with ≥1 disclosed trade, sorted by activity |
| `GET /api/members/:id` | profile + stats + recent trades |
| `GET /api/trades?ticker=AAPL&chamber=senate&limit=50` | recent trade feed |

Amounts are stored as the disclosed range (`amount_min`/`amount_max` + original
`amount_label`), never as an exact figure.
