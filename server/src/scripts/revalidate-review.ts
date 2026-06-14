/**
 * Re-validate parked OCR rows against the CURRENT validation rules and promote the ones that now
 * pass — no re-OCR, no API spend. Each review_queue row stores the raw model extraction
 * (`ExtractedTrade`); after a parser fix (e.g. MM/DD/YY dates, owner-typo normalization) many
 * previously-flagged rows clear every rule + the confidence gate and belong in `trades`.
 *
 *   npx tsx src/scripts/revalidate-review.ts --dry-run            (report only)
 *   npx tsx src/scripts/revalidate-review.ts                      (promote all eligible)
 *   npx tsx src/scripts/revalidate-review.ts --filer=khanna       (limit to one member)
 */
import { db, promoteReviewTrade } from "../db.js";
import { CONFIDENCE_THRESHOLD, validateTrade } from "../ocr/validate.js";
import type { ExtractedTrade } from "../ocr/types.js";
import { toIsoDate } from "../util/parse.js";

const dryRun = process.argv.includes("--dry-run");
const filerArg = process.argv.find((a) => a.startsWith("--filer="))?.split("=")[1]?.toLowerCase();

interface Row {
  id: number;
  filing_id: string;
  member_id: string;
  filed_date: string | null;
  full_name: string;
  raw_json: string;
  provider: string | null;
}

const rows = db
  .prepare(
    `SELECT rq.id, rq.filing_id, rq.raw_json, rq.provider,
            f.member_id, f.filed_date, m.full_name
     FROM review_queue rq
     JOIN filings f ON f.id = rq.filing_id
     JOIN members m ON m.id = f.member_id
     WHERE rq.resolved = 0`,
  )
  .all() as Row[];

let perTrade = 0;
let promoted = 0;
let stillParked = 0;
let skippedFilingLevel = 0;
const remainingReasons = new Map<string, number>();

for (const r of rows) {
  if (filerArg && !r.full_name.toLowerCase().includes(filerArg)) continue;

  let raw: any;
  try {
    raw = JSON.parse(r.raw_json);
  } catch {
    continue;
  }
  // Skip filing-level notes; only per-trade extractions have the confidence-wrapped fields.
  if (!raw || raw.filing || !raw.transaction_type || !raw.amount_label) {
    skippedFilingLevel++;
    continue;
  }
  perTrade++;

  const verdict = validateTrade(raw as ExtractedTrade, toIsoDate(r.filed_date), CONFIDENCE_THRESHOLD);
  if (!verdict.needsReview) {
    if (!dryRun) {
      promoteReviewTrade({
        reviewId: r.id,
        memberId: r.member_id,
        filingId: r.filing_id,
        provider: r.provider,
        vt: verdict,
      });
    }
    promoted++;
  } else {
    stillParked++;
    for (const why of verdict.reasons) {
      const key = why.split("(")[0].trim().slice(0, 48);
      remainingReasons.set(key, (remainingReasons.get(key) ?? 0) + 1);
    }
  }
}

console.log("=".repeat(60));
console.log(`RE-VALIDATION${filerArg ? ` (filer~"${filerArg}")` : ""}${dryRun ? " — DRY RUN" : ""}`);
console.log("=".repeat(60));
console.log(`Per-trade parked rows examined: ${perTrade}`);
console.log(`  ${dryRun ? "would promote" : "PROMOTED"} -> trades: ${promoted}`);
console.log(`  still parked:               ${stillParked}`);
console.log(`  filing-level notes skipped: ${skippedFilingLevel}`);
if (remainingReasons.size) {
  console.log("\nRemaining parked-row reasons:");
  for (const [why, n] of [...remainingReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${why}`);
  }
}
if (dryRun) console.log("\nNo changes written (--dry-run).");
