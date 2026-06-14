# PoliTracker

Tracks U.S. Congress (House + Senate) stock trades disclosed under the STOCK Act and presents
per-member trading profiles in a mobile app — plus company context (SEC financials, insider
activity, news) and the President's annual OGE holdings.

All data comes straight from official sources — there is no third-party trade API in between:

- **Senate** — [Electronic Financial Disclosures (eFD)](https://efdsearch.senate.gov/)
  Periodic Transaction Reports (PTRs): electronic ones as HTML tables, paper ones as scanned images.
- **House** — [Clerk Financial Disclosure](https://disclosures-clerk.house.gov/) annual index (ZIP)
  + per-filing PTR PDFs: online PTRs have extractable text, scanned PTRs (DocID `8…`) need OCR.
- **Enrichment** — [SEC EDGAR](https://www.sec.gov/) (Form 4 insider trades, XBRL financials),
  free news RSS (LLM-summarized — links + summaries only), and [OGE](https://www.oge.gov/) Form 278e
  (the President's annual holdings snapshot).

## Architecture

A mobile app can't scrape those sites directly (session/CSRF handling, ZIP/PDF/scan bundles), so the
project is two pieces:

```
server/   Node + TypeScript backend
          - scrapers/   pull + parse Senate & House PTRs (text)
          - ocr/        read scanned/paper PTRs: rasterize → vision → validate → confidence gate
          - agents/     enrichment: SEC EDGAR (insiders + financials), news RSS + LLM summaries
          - oge/        the President's annual OGE 278e holdings
          - db          normalize into SQLite
          - api         REST endpoints the app reads
mobile/   Expo (React Native) app
          - member list, per-member profile, company-context screen, holdings, dark + light themes
```

```
 Senate eFD ─┐  text + OCR
             ├─►  scrapers / ocr ─┐
 House Clerk ┘                    ├─►  SQLite ─►  REST API ─►  Expo app
 SEC EDGAR ──┐  agents / oge      │
 News RSS ───┼────────────────────┘
 OGE 278e ───┘
```

OCR-sourced trades that don't clear the validation + confidence gate are kept as **unverified** and
shown flagged, never mixed in as confirmed data.

## Quick start

```bash
# 1. Backend
cd server
npm install
npm run scrape            # text PTRs (Senate electronic + House online) → server/data/politracker.db
npm run scrape:ocr        # optional: OCR the scanned/paper PTRs (needs an OCR provider; see server/README)
npm run dev               # serves the API on http://localhost:4000

# optional enrichment (SEC EDGAR + news), idempotent:
npm run job -- companies && npm run job -- insider && npm run job -- financials

# 2. Mobile app (second terminal)
cd mobile
npm install
npm start                 # opens Expo; press i (iOS), a (Android), or w (web)
```

See [server/README.md](server/README.md), [mobile/README.md](mobile/README.md), and
[STATUS.md](STATUS.md) for details.

## Data & ethics

All data is public record published under the STOCK Act (and SEC/OGE disclosures). Scrapers are
deliberately low-volume and polite (rate-limited, descriptive User-Agent). Amounts are disclosed as
**ranges**, not exact figures — the app preserves that — and there is a ~45-day reporting lag, so
nothing here is real-time.
