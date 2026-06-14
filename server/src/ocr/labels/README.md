# OCR ground-truth labels

One JSON file per fixture PDF, named the same as the fixture but with a `.json`
extension (e.g. `khanna-rohit-ca17-8220127.json` ↔
`../fixtures/khanna-rohit-ca17-8220127.pdf`).

These are **committed** (the fixture PDFs are gitignored; re-fetch them with
`npm run ocr:fetch-fixtures`). The labels are the valuable, reproducible artifact
the eval harness scores extraction against.

## Format

Value-only ground truth in the [`ExpectedFiling`](../types.ts) shape — the
extraction schema from [`../ptr-extraction-spec.md`](../ptr-extraction-spec.md)
**without** the `confidence` wrappers. Label what is *on the form* (the raw layer):

- `transaction_type`: `P` | `S` | `S_partial` | `E`
- `owner`: `self` | `spouse` | `dependent_child` | `joint`
- dates: `MM/DD/YYYY`
- `amount_label`: **verbatim** from the form (must be one of the 10 canonical buckets)
- `ticker`: only if a symbol is printed; otherwise `null`
- `asset_name`: verbatim as printed

## Rules

- **Never guess.** Unreadable cell → `null`. Entirely unreadable row → include it
  with `"row_unreadable": true` and `null` for the unreadable fields.
- **All pages, reading order, merged** into one `transactions` array (don't restart
  per page). For a long filing labeled only in part, set `pages_labeled`
  (e.g. `"1-2 of 28"`) so the harness scores only what's covered.
- The eval normalizes both sides before comparing (dash variants, date parsing,
  amount→bucket, case/space for names), so verbatim labels are fine.

## Workflow

Drafts are produced by reading rendered page images, then **human-verified** — a
draft is not ground truth until a person has checked it. Spot-check low-confidence
rows especially.
