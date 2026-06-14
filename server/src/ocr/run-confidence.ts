/**
 * `npm run ocr:confidence` — confidence-vs-correctness analysis. Answers the safety question the
 * accuracy report can't: when the model is wrong, does the validation gate catch it (route to
 * review) or auto-ingest it confidently (a silent error)?
 *
 *   npm run ocr:confidence                      # every provider with a key, all fixtures
 *   npm run ocr:confidence -- --provider=claude # one provider
 *   npm run ocr:confidence -- --threshold=0.9   # try a different gate threshold
 *
 * Extractions are cached on disk (src/ocr/.cache), so re-running to retune the threshold is free.
 */
import { cachedExtract } from "./cache.js";
import { loadEnv } from "./env.js";
import {
  accumulateConfidence,
  formatConfidenceReport,
  newConfidenceReport,
  pagesFromLabel,
} from "./eval.js";
import { loadLabels } from "./labels.js";
import { loadFixturePages } from "./preprocess.js";
import { availableProviders } from "./providers/index.js";
import { CONFIDENCE_THRESHOLD } from "./validate.js";

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--provider="))?.split("=")[1];
  const threshold = Number(args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ?? CONFIDENCE_THRESHOLD);

  const labels = loadLabels();
  console.log(
    `Loaded ${labels.length} labeled fixtures, ${labels.reduce((n, l) => n + l.transactions.length, 0)} transactions.`,
  );

  const providers = availableProviders().filter((p) => !only || p.name === only);
  if (providers.length === 0) {
    console.log("No providers available. Set ANTHROPIC_API_KEY / OPENAI_API_KEY in .env.");
    return;
  }
  console.log(`Providers: ${providers.map((p) => p.name).join(", ")}`);

  for (const provider of providers) {
    const rep = newConfidenceReport(provider.name, threshold);
    for (const label of labels) {
      process.stdout.write(`  [${provider.name}] ${label.fixture} … `);
      try {
        const images = await loadFixturePages(label.fixture, { pages: pagesFromLabel(label) });
        const extracted = await cachedExtract(provider, label.fixture, images);
        accumulateConfidence(rep, label, extracted);
        console.log(`${extracted.transactions.length} rows`);
      } catch (err) {
        console.log(`ERROR: ${(err as Error).message}`);
      }
    }
    console.log(formatConfidenceReport(rep));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
