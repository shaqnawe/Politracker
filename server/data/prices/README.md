# Price data (CSV) — for the research/analysis models

The forward-return engine (`src/agents/research/returns.ts`) needs daily
**adjusted-close** history for each traded/mentioned ticker **and** the S&P 500
benchmark. No official/free U.S. gov source publishes market prices, so this is
the project's one third-party data dependency — and it's kept out of any live
fetch by default: **you supply the data here as CSV** (`RESEARCH_PRICE_PROVIDER=csv`,
the default), and it's cached into the `price_bars` table on first use.

## Format

One file per symbol, named `SYMBOL.csv` (upper-case; the benchmark file must be
`SPY.csv`). Header with a `Date` column and an `Adj Close` (preferred) or
`Close` column; extra columns are ignored, and `#`-prefixed lines are skipped.

```csv
Date,Adj Close,Volume
2023-05-23,169.19,55964400
2023-05-24,169.46,54834900
2023-05-25,170.60,56058300
```

A Yahoo/Stooq/broker "historical prices" CSV export usually works as-is (it has
`Date` + `Adj Close`/`Close`). Class shares use a hyphen (e.g. `BRK-B.csv`).
An optional **`Volume`** column enables Model A's MA8 abnormal-volume signal; it's
ignored if absent.

## Loading

- **Drop files here** and just run a model — the CSV provider reads + caches them
  lazily. Or
- **Bulk import** with `npm run research:import-prices -- --dir=server/data/prices`
  (per-symbol files) or `--file=export.csv` (a single file with a `Symbol`
  column). This pre-warms the `price_bars` cache and prints coverage.

## Notes

- Files here are **gitignored** (third-party data). The committed synthetic
  fixtures under `src/agents/research/fixtures/prices/` are sample data for the
  engine self-test only — **not real market data**.
- Anything before the earliest bar you provide resolves to `no_entry_price`;
  horizons past your latest bar resolve to `insufficient_history` — never faked.
- Alternative source (fragile, keyless): `RESEARCH_PRICE_PROVIDER=yahoo` pulls
  from Yahoo Finance, but it throttles hard per-IP on multi-ticker backfills.
