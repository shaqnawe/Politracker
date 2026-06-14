import { createHash } from "node:crypto";
import {
  companiesWithFinancials,
  financialsForTicker,
  getNote,
  upsertNote,
  type FinancialDatum,
} from "../db.js";
import { REVIEW_MODEL, reviewFinancials } from "../llm.js";

/**
 * Financial-review agent: turn the collected XBRL numbers into a short grounded narrative + flags
 * (company_notes, kind='financial_review'). Cost control: the note carries a hash of the exact
 * financial inputs, so a company is only (re)reviewed when its numbers changed. Deterministic
 * formatting in, LLM only for the narrative/flags.
 */
const KIND = "financial_review";

export interface ReviewOptions {
  maxCompanies?: number;
  log?: (msg: string) => void;
}

/** Compact, stable text table of a company's annual metrics (also the basis for the change hash). */
function formatFinancials(rows: FinancialDatum[]): string {
  const byMetric = new Map<string, FinancialDatum[]>();
  for (const r of rows) (byMetric.get(r.metric) ?? byMetric.set(r.metric, []).get(r.metric)!).push(r);
  const fmt = (r: FinancialDatum) => {
    const v =
      r.unit === "USD" ? `$${(r.value / 1e9).toFixed(2)}B` : r.value.toLocaleString("en-US");
    return `FY${r.fiscal_year}=${v}`;
  };
  const lines: string[] = [];
  for (const [metric, ds] of byMetric) {
    const unit = ds[0]?.unit ?? "";
    lines.push(`${metric} (${unit}): ${ds.map(fmt).join(" ")}`);
  }
  return lines.join("\n");
}

export async function reviewCompanyFinancials(
  opts: ReviewOptions = {},
): Promise<{ companies: number; reviewed: number; skipped: number }> {
  const log = opts.log ?? (() => {});
  const companies = companiesWithFinancials(opts.maxCompanies);
  log(`Financial review: ${companies.length} companies with financials…`);

  let reviewed = 0;
  let skipped = 0;
  for (const co of companies) {
    const rows = financialsForTicker(co.ticker);
    if (rows.length === 0) continue;
    const table = formatFinancials(rows);
    const hash = createHash("sha1").update(table).digest("hex").slice(0, 16);

    // Skip if we already reviewed these exact numbers (cost control / idempotent).
    if (getNote(co.ticker, KIND)?.source_hash === hash) {
      skipped++;
      continue;
    }

    let review;
    try {
      review = await reviewFinancials(co.name ?? co.ticker, table);
    } catch (err) {
      log(`Financial review: ${co.ticker} failed: ${(err as Error).message}`);
      continue;
    }
    upsertNote({
      ticker: co.ticker,
      kind: KIND,
      body: review.narrative,
      flagsJson: JSON.stringify(review.flags),
      sourceHash: hash,
      model: REVIEW_MODEL,
    });
    reviewed++;
    log(`Financial review: ${co.ticker} — ${review.flags.join(", ") || "no flags"}`);
  }

  log(`Financial review: ${reviewed} reviewed, ${skipped} unchanged.`);
  return { companies: companies.length, reviewed, skipped };
}
