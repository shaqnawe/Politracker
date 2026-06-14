# Forward Return Engine — Methodology Spec

Implemented in `server/src/agents/research/returns.ts` (engine) +
`prices.ts` (price layer, default source Yahoo Finance — keyless, adjusted close) +
`db.ts` (price cache) — everything lives in this one research dir. Both analysis models (A: statement-driven, B:
trade-driven) call this one engine so returns are defined identically. Implement
to this spec; do not let either model invent its own return math.

This is correlation/event-study analysis, **not** a trading signal or financial
advice. Label all output accordingly.

---

## 1. What it computes

Given an **event** (a dated statement or a dated trade) referencing a **ticker**,
compute the ticker's **forward abnormal return** versus the S&P 500 at fixed
horizons: **1 day, 1 week, 1 month, 3 months**.

Public function shape (as implemented):
```ts
computeForwardReturns({
  ticker: string,
  eventDate: string,         // ISO; statement timestamp or trade transaction date
  entry: 'trade' | 'statement', // selects the per-model entry policy (§4) — explicit, not inferred
  eventHasIntradayTime: boolean,
  direction?: 'buy' | 'sell',   // trades only; statements omit
  unsupportedAsset?: boolean    // model flags a non-equity asset → unsupported_asset (§7)
}, prices: PriceAccess) => EventReturns
```
`prices` is an injected `PriceAccess` (benchmark series = the trading calendar +
per-ticker series); the models build it once via `prices.buildPriceAccess(...)`
and pass it per event, so the engine itself does no I/O and is pure/testable.

---

## 2. The trading calendar IS the benchmark series

Do not hardcode a holiday calendar. Define **valid trading days** as the set of
dates present in the benchmark price series (use an investable S&P 500 proxy —
SPY — or `^GSPC`). All entry/exit dates snap to this calendar. This keeps the
stock and benchmark on identical dates automatically.

Horizons are expressed in **trading-day offsets** from the entry day:
| Label | Trading days after entry |
|-------|--------------------------|
| 1d    | 1   |
| 1w    | 5   |
| 1m    | 21  |
| 3m    | 63  |

(Trading-day windows, not calendar days, so weekends/holidays never shift a
window. A calendar-day variant is a valid refinement to propose later, not the
baseline.)

---

## 3. Prices: always adjusted close

Use **split- and dividend-adjusted close** for both the ticker and the
benchmark. Raw close will manufacture fake ±50% returns on split dates. Pin the
price source and adjustment method; record the data vintage for reproducibility.

---

## 4. Entry anchoring (t0) — this is the main no-look-ahead guard

`t0` is the entry trading day; `P0` is its adjusted close.

- **Trades (Model B):** `t0` = the transaction date if it is a trading day, else
  the next trading day. We measure how the position did *from the trade date
  forward* — that is the member's own action date, so same-day close is correct.
- **Statements (Model A):** `t0` = the first trading day whose **close occurs
  strictly after** the statement timestamp. If only a date is known (no time),
  assume an outside observer could not act until the **next** trading day's
  close, so `t0` = next trading day after the statement date. This prevents
  crediting a move that happened before the statement was public.

Make the entry policy a documented, per-model constant so it's auditable.

---

## 5. Return math

For each horizon `h` (in trading days), let `tH = t0 + h` on the trading
calendar, `P(tH)` = ticker adjusted close, `B0`/`B(tH)` = benchmark closes on the
same two dates.

```
raw_return(h)       = P(tH) / P0 - 1
benchmark_return(h) = B(tH) / B0 - 1
abnormal_return(h)  = raw_return(h) - benchmark_return(h)   // market-adjusted, beta = 1
```

`abnormal_return` is the headline metric — it strips out general market drift, so
you measure the move *attributable to the event*, not the tide.

(Refinement to PROPOSE, not bake in now: a full market model
`AR = R - (alpha + beta * Rb)` with alpha/beta estimated over a pre-event window
[t0-150, t0-30]. More rigorous; needs the estimation window to exist.)

---

## 6. Direction sign

- **buy:** `signed_return(h) = abnormal_return(h)` (up is good).
- **sell:** `signed_return(h) = -abnormal_return(h)` (a sale that dodges a drop
  is a *good* call, so a subsequent decline is a positive signed return).
- **statements (no direction):** `signed_return = abnormal_return` (unsigned).
  Only sign by sentiment if a model explicitly extracts bullish/bearish
  direction; default is unsigned.

This is the trap that silently breaks Model B if missed: a well-timed sell looks
like a "loss" unless you flip the sign.

---

## 7. Missing data — return null + a status, never fabricate

Per event, set a top-level `status`; per horizon, set a horizon `status`.

- **Unresolved ticker** (symbol can't be mapped) → event status
  `unresolved_ticker`, all horizons null.
- **Non-equity asset** (option, bond, crypto, mutual fund — common in PTRs) →
  event status `unsupported_asset`, all horizons null. Do NOT price an option
  off its underlying.
- **No entry price** (ticker not yet listed at t0) → `no_entry_price`, null.
- **Horizon extends past the last available date** (event too recent) → that
  horizon status `insufficient_history`, value null. Other horizons may still
  resolve.
- **Exit day is a data gap** for a thin name → use the nearest prior available
  trading day within a small tolerance (default 3 trading days); beyond that,
  null with status `price_gap`.
- **Delisting/acquisition before a horizon** → status `delisted`; treat as a real
  outcome and flag (a sell just before a delisting-to-zero is meaningful, not an
  error).

---

## 8. Output schema (per event)

```jsonc
{
  "ticker": "NVDA",
  "direction": "buy",            // or "sell" or null
  "entry_date": "2025-04-03",
  "entry_price": 0.0,
  "status": "ok",                // or unresolved_ticker | unsupported_asset | no_entry_price
  "horizons": {
    "1d": { "exit_date": "...", "exit_price": 0.0, "raw_return": 0.0,
            "benchmark_return": 0.0, "abnormal_return": 0.0,
            "signed_return": 0.0, "status": "ok" },
    "1w": { },
    "1m": { },
    "3m": { }
  },
  "notes": ""
}
```

---

## 9. Aggregation guidance (for the models, not this engine)

When the models roll events up per figure / per member / per ticker, each group
must report: **n** (sample size), mean and median signed abnormal return,
dispersion (std), and **hit rate** (% of events with positive signed return).
Always show n and dispersion — never a bare average.

- Flag groups with `n < MIN_SAMPLE` (default 10) as low-confidence.
- Note the **overlapping-windows** caveat: many events close together reuse the
  same price period, which inflates apparent significance. For significance,
  prefer non-overlapping events or report a bootstrapped confidence interval and
  state the caveat.
- **Model B only:** weight by the trade's amount-range **midpoint** (amounts are
  ranges, so label every dollar-weighted figure an estimate), and **exclude
  `needs_review` / OCR-provisional trades** from headline numbers — report them
  separately if at all.

---

## 10. Tunable constants (name them, don't inline)

`HORIZONS = {1d:1, 1w:5, 1m:21, 3m:63}`, `BENCHMARK = 'SPY'`,
`GAP_TOLERANCE_DAYS = 3`, `MIN_SAMPLE = 10`, plus the per-model entry policy.
Surfacing these makes the methodology auditable and lets you tune from results
rather than edit logic.
