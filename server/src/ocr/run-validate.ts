/**
 * `npm run ocr:validate` — exercise the validator.
 *
 *   npm run ocr:validate                 # validate the hand labels (lifted to conf=1.0); no API
 *   npm run ocr:validate -- --provider=claude   # extract each fixture then validate (API calls)
 *
 * The default (labels) mode is deterministic: it checks the rule logic. A perfect, fully-read
 * filing should auto-ingest every trade; structural gaps (e.g. a null amount) should route to
 * review.
 */
import { loadEnv } from "./env.js";
import { loadLabels } from "./labels.js";
import { loadFixturePages } from "./preprocess.js";
import { availableProviders } from "./providers/index.js";
import { validateExtraction } from "./validate.js";
import type { ExpectedFiling, ExtractedFiling } from "./types.js";

const conf = <T>(value: T | null) => ({ value, confidence: 1 });

/** Treat a hand label as a perfect (confidence 1.0) extraction, to test rule logic. */
function liftLabel(l: ExpectedFiling): ExtractedFiling {
  return {
    filing: {
      filer_name: conf(l.filing.filer_name),
      filing_date: conf(l.filing.filing_date),
      chamber: conf(l.filing.chamber),
    },
    transactions: l.transactions.map((t) => ({
      owner: conf(t.owner),
      asset_name: conf(t.asset_name),
      ticker: conf(t.ticker),
      asset_type: conf(t.asset_type),
      transaction_type: conf(t.transaction_type),
      transaction_date: conf(t.transaction_date),
      notification_date: conf(t.notification_date),
      amount_label: conf(t.amount_label),
      row_unreadable: t.row_unreadable,
    })),
    extraction_notes: "",
  };
}

function report(fixture: string, extracted: ExtractedFiling, expectedFiler: string | null, filingDate: string | null) {
  const v = validateExtraction(extracted, { expectedFiler, filingDate });
  const auto = v.trades.filter((t) => !t.needsReview).length;
  const review = v.trades.length - auto;
  console.log(`\n${fixture}: ${v.trades.length} trades — ${auto} auto-ingest, ${review} review`);
  if (v.filingReasons.length) console.log(`  filing: ${v.filingReasons.join("; ")}`);
  for (const t of v.trades) {
    if (t.needsReview)
      console.log(`  REVIEW ${(t.trade.ticker ?? t.trade.assetName).slice(0, 28).padEnd(28)} ${t.reasons.join("; ")}`);
  }
}

async function main(): Promise<void> {
  loadEnv();
  const provider = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1];
  const labels = loadLabels();

  if (!provider) {
    console.log("Validating hand labels (lifted to confidence 1.0) — deterministic rule check:");
    for (const l of labels) report(l.fixture, liftLabel(l), l.filing.filer_name, l.filing.filing_date);
    return;
  }

  const p = availableProviders().find((x) => x.name === provider);
  if (!p) return console.log(`Provider '${provider}' not available (check API key).`);
  console.log(`Extracting + validating with ${p.name}:`);
  for (const l of labels) {
    const pages = l.pages_labeled?.split(/of/i)[0].match(/\d+/g)?.map(Number);
    const images = await loadFixturePages(l.fixture, { pages });
    report(l.fixture, await p.extract(images), l.filing.filer_name, l.filing.filing_date);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
