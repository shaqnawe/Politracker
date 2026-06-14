# Research / analysis models

Two event-study models that measure stock moves around events, on top of one
shared forward-return engine. **Everything here is correlation analysis — not a
trading signal and not financial advice.** Real numbers require price data you
supply (no official/free price source exists); see `../../../data/prices/README.md`.

## Shared core

- **`returns.ts`** — the engine. Forward **abnormal** return vs the S&P 500 at
  1d/1w/1m/3m, trading-day horizons, no-look-ahead entry anchoring, buy/sell sign,
  `null`+status on missing data, optional α/β market model, pre-event run-up. Spec:
  **`returns-spec.md`**.
- **`prices.ts`** + **`db.ts` (`price_bars`)** — pluggable price provider behind a
  local cache. Default `csv` (you supply files); `yahoo` fallback (fragile).
- **`aggregate.ts`** — per-group roll-up (n, mean, median, std, hit rate, weighted
  mean; low-n flag). **`stats.ts`** — bootstrap CIs, Benjamini–Hochberg FDR,
  shrinkage, OLS.

## Model B — disclosed congressional trades  (`model-b.ts`)

How members' disclosed trades performed, from the **transaction date**, signed by
direction, weighted by amount-range midpoint (estimate). Refinements R1–R7, R9
applied (R8/committee deferred — no data). Methodology: **`model-b-methodology.md`**.
Run: `npm run research:model-b`.

## Model A — public-figure statements  (`model-a.ts`)

Whether figures' dated statements about stocks precede price moves (unsigned,
entered the first close after the statement). Statements are **supplied as JSON**
(`run-ingest-statements.ts`); tickers extracted **deterministically**
(`statements-extract.ts`, never fabricated). Methodology: **`model-a-methodology.md`**.
Run: `npm run research:ingest-statements -- --file=...` then `npm run research:model-a`.

## Commands

| Command | What |
| --- | --- |
| `npm run research:selftest` | deterministic engine + stats + extraction tests (no network/DB writes) |
| `npm run research:import-prices -- --dir=… \| --file=…` | load adjusted-close CSVs into the price cache |
| `npm run research:model-b` | score + report disclosed trades → `data/reports/model-b-latest.md` |
| `npm run research:ingest-statements -- --file=…` | ingest statements + extract mentions |
| `npm run research:model-a` | score + report statement mentions → `data/reports/model-a-latest.md` |

Runner flags (`model-a`/`model-b`): `--prices=<dir>` (read CSVs from a dir),
`--no-cache` (bypass the DB price cache), `--dry` (don't persist). Reports under
`server/data/reports/` are gitignored (numbers depend on the price data loaded).
