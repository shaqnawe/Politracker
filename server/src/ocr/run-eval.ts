/**
 * `npm run ocr:eval` — measures OCR extraction against the hand labels, per provider,
 * field by field. This is how we compare providers and tune thresholds.
 *
 *   npm run ocr:eval                       # every provider with a key, over all fixtures
 *   npm run ocr:eval -- --self-test        # score labels against themselves (no API calls)
 *   npm run ocr:eval -- --provider=claude  # one provider
 *   npm run ocr:eval -- --fixture=luna     # only fixtures whose name contains "luna"
 *   npm run ocr:eval -- --max=2            # cap number of fixtures (keep cost down)
 */
import { cachedExtract } from "./cache.js";
import { loadEnv } from "./env.js";
import { loadLabels } from "./labels.js";
import { formatReport, newScore, pagesFromLabel, projectExtracted, scoreFixture } from "./eval.js";
import { loadFixturePages } from "./preprocess.js";
import { availableProviders } from "./providers/index.js";
import type { ExpectedFiling, OcrProvider } from "./types.js";

const loadPageImages = (label: ExpectedFiling): Promise<Buffer[]> =>
  loadFixturePages(label.fixture, { pages: pagesFromLabel(label) });

function selfTest(labels: ExpectedFiling[]): void {
  const score = newScore("self-test (label vs itself)");
  for (const l of labels) scoreFixture(score, l, { filing: l.filing, transactions: l.transactions });
  console.log(formatReport(score));
  const ok = score.misses.length === 0 && score.rows.matched === score.rows.expected && score.rows.spurious === 0;
  console.log(ok ? "\nscorer OK: labels score 100% against themselves." : "\nWARNING: scorer not 100% on identity.");
}

async function evalProvider(provider: OcrProvider, labels: ExpectedFiling[]): Promise<void> {
  const score = newScore(provider.name);
  for (const label of labels) {
    process.stdout.write(`  [${provider.name}] ${label.fixture} … `);
    try {
      const images = await loadPageImages(label);
      const extracted = await cachedExtract(provider, label.fixture, images);
      scoreFixture(score, label, projectExtracted(extracted));
      console.log(`${extracted.transactions.length} rows`);
    } catch (err) {
      console.log(`ERROR: ${(err as Error).message}`);
    }
  }
  console.log(formatReport(score));
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const only = args.find((a) => a.startsWith("--provider="))?.split("=")[1];
  const fixtureFilter = args.find((a) => a.startsWith("--fixture="))?.split("=")[1];
  const max = Number(args.find((a) => a.startsWith("--max="))?.split("=")[1] ?? Infinity);

  let labels = loadLabels();
  if (fixtureFilter) labels = labels.filter((l) => l.fixture.includes(fixtureFilter));
  if (Number.isFinite(max)) labels = labels.slice(0, max);
  console.log(
    `Loaded ${labels.length} labeled fixtures, ${labels.reduce((n, l) => n + l.transactions.length, 0)} transactions.`,
  );

  if (args.includes("--self-test")) return selfTest(labels);

  const providers = availableProviders().filter((p) => !only || p.name === only);
  if (providers.length === 0) {
    console.log("\nNo providers available. Set ANTHROPIC_API_KEY / OPENAI_API_KEY in .env,");
    console.log("or run `npm run ocr:eval -- --self-test` to validate the scorer.");
    return;
  }
  console.log(`Providers: ${providers.map((p) => p.name).join(", ")}\n`);
  for (const provider of providers) await evalProvider(provider, labels);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
