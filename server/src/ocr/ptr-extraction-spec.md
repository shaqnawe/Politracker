# PTR OCR — Extraction Schema & Validation Rules

Target spec for `src/ocr/extract.ts` (Step 4) and `src/ocr/validate.ts`
(Step 5). Field **names below are logical** — map each to the actual field in
`src/util/types.ts` (`TradeInput` / `FilingInput`). If a name already exists
there, use the existing one; do not introduce a parallel vocabulary.

---

## 1. Extraction output schema

Each field the model returns is wrapped as `{ value, confidence }` where
`confidence` is 0–1. `value` is `null` when the field cannot be read. The model
returns one object per filing:

```jsonc
{
  "filing": {
    "filer_name":   { "value": "string|null", "confidence": 0.0 },
    "filing_date":  { "value": "MM/DD/YYYY|null", "confidence": 0.0 }, // PTR disclosure/filed date
    "chamber":      { "value": "house|senate|null", "confidence": 0.0 }
  },
  "transactions": [
    {
      "owner":            { "value": "self|spouse|dependent_child|joint|null", "confidence": 0.0 },
      "asset_name":       { "value": "string|null", "confidence": 0.0 },
      "ticker":           { "value": "string|null", "confidence": 0.0 }, // null if none printed
      "asset_type":       { "value": "stock|option|bond|etf|mutual_fund|crypto|other|null", "confidence": 0.0 },
      "transaction_type": { "value": "P|S|S_partial|E|null", "confidence": 0.0 },
      "transaction_date": { "value": "MM/DD/YYYY|null", "confidence": 0.0 },
      "notification_date":{ "value": "MM/DD/YYYY|null", "confidence": 0.0 },
      "amount_label":     { "value": "string|null", "confidence": 0.0 }, // verbatim range text
      "row_unreadable":   false
    }
  ],
  "extraction_notes": "string" // e.g. "page 2 handwritten and faint"
}
```

### Rules the model MUST follow (put these in the adapter's system prompt)
- Transcribe only what is visibly present. **Never infer, complete, or guess**
  a value. If a cell is unreadable, return `value: null` with low confidence and,
  for an entire unreadable row, set `row_unreadable: true`.
- `amount_label` must be copied **verbatim** from the form (do not normalize it
  in the model; validation does that downstream).
- A ticker only goes in `ticker` if it is printed on the form (usually in
  parentheses after the asset name). Do not invent a ticker from the company name.
- Process every page; a single transaction table may span pages — merge rows in
  reading order, do not restart numbering per page.
- Output strict JSON only, matching the schema above. No prose outside it.

---

## 2. Canonical PTR amount ranges

`amount_label` must resolve to exactly one of these buckets. Normalize before
matching: trim, collapse spaces, treat en-dash/em-dash/hyphen as the same, and
treat "Over" / "More than" as equivalent.

| Canonical label        | amount_min  | amount_max   |
|------------------------|-------------|--------------|
| $1,001 – $15,000       | 1001        | 15000        |
| $15,001 – $50,000      | 15001       | 50000        |
| $50,001 – $100,000     | 50001       | 100000       |
| $100,001 – $250,000    | 100001      | 250000       |
| $250,001 – $500,000    | 250001      | 500000       |
| $500,001 – $1,000,000  | 500001      | 1000000      |
| $1,000,001 – $5,000,000| 1000001     | 5000000      |
| $5,000,001 – $25,000,000 | 5000001   | 25000000     |
| $25,000,001 – $50,000,000 | 25000001 | 50000000     |
| Over $50,000,000       | 50000001    | null         |

Use the existing `parse.ts` range parser to produce `amount_min` / `amount_max`;
this table is the allowed set, not a second parser. A label that matches none of
these after normalization → `needs_review`.

---

## 3. Owner & transaction-type normalization

- **Owner codes on the form:** blank / "Self" → `self`; `SP` → `spouse`;
  `DC` → `dependent_child`; `JT` → `joint`. Anything else → `null` + `needs_review`.
- **Transaction type:** `P` = purchase, `S` = sale, `S (partial)` → `S_partial`,
  `E` = exchange. Map `S_partial` onto the existing `S` representation plus a
  partial flag if the schema supports one; otherwise store `S` and note it.

---

## 4. Validation rules (Step 5)

Run per transaction. Each failure adds a reason and sets `needs_review = 1`.

**Essential fields** (must be present, valid, and above the confidence gate to
auto-ingest): `owner`, `asset_name` OR `ticker`, `transaction_type`,
`transaction_date`, `amount_label`.

1. **transaction_type** ∈ {P, S, S_partial, E}. Else fail.
2. **transaction_date**: parses as MM/DD/YYYY (via `parse.ts`). Else fail.
3. **notification_date** (if present): parses; and `transaction_date <=
   notification_date`. Violation → flag (not fatal, since the form occasionally
   has odd ordering, but mark for review).
4. **date sanity**: `transaction_date <= filing.filing_date`, and
   `transaction_date` not in the future and not more than ~3 years before the
   filing date. Out of range → flag.
5. **amount_label** resolves to a canonical bucket (Section 2). Else fail.
6. **owner** normalizes to the allowed set (Section 3). Else fail.
7. **asset_name** non-empty when `ticker` is null (need at least one identifier).
   Both null → fail.
8. **ticker** (if present): matches `^[A-Z][A-Z.\-]{0,6}$`; if a symbol list is
   available, flag (not fail) unknown tickers — new/delisted symbols are real.
   If the model left `ticker` null but the asset_name contains a parenthesized
   symbol, recover it with the existing `parse.ts` ticker extractor.

**Filing-level checks**
- If the page clearly contained a transaction table but `transactions` is empty
  → mark the whole filing `needs_review` (likely a read failure, not a real
  empty PTR).
- `filing.filer_name` should loosely match the member the filing is attributed
  to from the index; mismatch → flag. (Ingest by the index member, not the OCR
  name — the OCR name is only a cross-check.)

---

## 5. Confidence gate & routing (feeds Step 6)

- **Per-field confidence threshold:** start at `0.85` (make it a constant so we
  can tune it from the eval results). Any **essential** field below the threshold
  → that trade `needs_review`.
- **row_unreadable = true** → straight to `review_queue`, never auto-ingest.
- **Auto-ingest** (`source='ocr'`, `needs_review=0`) only when: all essential
  fields present, all validation rules pass, and all essential fields clear the
  confidence gate.
- **Otherwise** → `review_queue` with: the raw extraction JSON, the per-field
  confidences, and the explicit list of failed rule numbers / low-confidence
  fields. The reasons list is what makes manual review fast.

---

## 6. House PTR scanned-form layout (verified against fixtures)

The scanned House PTR is a **checkbox grid**, not free text. Columns left→right,
grouped under their printed headers:

| Group | Columns (left→right) |
|-------|----------------------|
| **Full Asset Name** | owner code (`SP`/`DC`/`JT`; blank = self) · asset full name (not a ticker symbol) |
| **Type of Transaction** | ☐ Purchase · ☐ Sale · ☐ Exchange · ☐ Capital gains exceed $200 · ☐ Partial transaction |
| **Date of Transaction** | MM/DD/YY |
| **Date Notified of Transaction** | MM/DD/YY |
| **Amount of Transaction** | ☐ $1,001–$15,000 · ☐ $15,001–$50,000 · ☐ $50,001–$100,000 · ☐ $100,001–$250,000 · ☐ $250,001–$500,000 · ☐ $500,001–$1,000,000 · ☐ $1,000,001–$5,000,000 · ☐ $5,000,001–$25,000,000 · ☐ $25,000,001–$50,000,000 · ☐ Over $50,000,000 · ☐ Transaction in a Spouse or Dependent-Child asset over $1,000,000 |

**Extraction implications (must be in the adapter prompt):**
- **`transaction_type` is the checked box** in the Type group: Purchase→`P`,
  Sale→`S`, Exchange→`E`. The **Partial** box checked alongside Sale → `S_partial`.
- **"Capital gains exceed $200" is a SEPARATE yes/no flag, NOT a transaction
  type.** Do not read it as Partial. (This caused a mislabel during fixture
  labeling — Sales with the cap-gains box checked were wrongly tagged partial.)
- **`amount_label` is the checked box** in the Amount group — exactly one of the
  buckets in §2. The final column, *"Transaction in a Spouse or Dependent-Child
  asset over $1,000,000"*, is a **special disclosure flag, not a normal bucket**;
  it does not map to the §2 table → set `amount_label: null` + `needs_review`
  (and note it), rather than forcing it into "Over $50,000,000".
- **Orientation varies per filing** (pages are often rotated 90°/270°; some are
  upright). Preprocess (STEP 3) must auto-orient before extraction.
- A **blank owner column = `self`**.
- **Column sets vary between form variants** — the single-filer PTR has a single
  "Partial Sale" type column, whereas the trust-grid variant (above) separates
  "Capital gains exceed $200" and "Partial". The model must map by the **printed
  header label, not a fixed column index**.
