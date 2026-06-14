import { filingOcrProvider, hasFiling, ingestFiling, ingestOcrFiling } from "../db.js";
import { extractChunked, isQuotaError } from "../ocr/chunked.js";
import { preprocessPage } from "../ocr/preprocess.js";
import { defaultProvider } from "../ocr/providers/index.js";
import { validateExtraction } from "../ocr/validate.js";
import type { OcrCandidate, ScrapedFiling } from "../util/types.js";
import { scrapeHouse, scrapeHouseScanned } from "./house.js";
import { scrapeSenate, scrapeSenatePaper } from "./senate.js";

interface Args {
  source: "all" | "senate" | "house";
  max: number;
  year: number;
  start: string;
  /** OCR the scanned filings the text scrapers skip (Senate paper, House DocID "8…"). */
  ocr: boolean;
  /** With --ocr: list the candidate filings only — no PDF downloads, no (paid) vision calls. */
  dryRun: boolean;
  /** Only process filers whose name contains this substring (targeted backfills). */
  filer?: string;
  /** Pages per vision request; large filings are split into chunks of this size (TPM safety). */
  chunk: number;
  /** Seconds to wait between chunks so each lands in its own per-minute token window. */
  chunkSpacing: number;
  /** Re-OCR existing filings whose ocr_provider == this value (e.g. "claude-cli"), replacing their
   *  rows — to redo a batch with a better model. Without it, ingested filings are skipped. */
  redo?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
  const has = (k: string) => argv.includes(`--${k}`);
  return {
    source: (get("source") as Args["source"]) ?? "all",
    max: Number(get("max") ?? 50),
    year: Number(get("year") ?? new Date().getFullYear()),
    start: get("start") ?? "01/01/2024",
    ocr: has("ocr"),
    dryRun: has("dry-run"),
    filer: get("filer"),
    chunk: Number(get("chunk") ?? 8),
    chunkSpacing: Number(get("chunk-spacing") ?? 60),
    redo: get("redo"),
  };
}

async function ingestAll(label: string, gen: AsyncGenerator<ScrapedFiling>) {
  let filings = 0;
  let trades = 0;
  for await (const scraped of gen) {
    const inserted = ingestFiling(scraped);
    if (inserted) {
      filings++;
      trades += scraped.trades.length;
    }
  }
  console.log(`\n${label}: ingested ${filings} new filings, ${trades} trades.`);
}

/**
 * OCR path: pick up exactly the scanned filings the text scrapers skip, then for each one
 * download → rasterize/preprocess → extract (vision) → validate → route into trades/review.
 * Incremental (skips already-ingested filings) and safe to re-run on a cron. With --dry-run it
 * only enumerates candidates, so selection can be verified without any download or API spend.
 */
async function runOcr(args: Args) {
  const log = (m: string) => console.log(m);
  const provider = args.dryRun ? undefined : defaultProvider();
  if (!args.dryRun && !provider) {
    console.error(
      "OCR: no provider available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in .env " +
        "(and optionally OCR_PROVIDER to choose between them).",
    );
    process.exit(1);
  }

  // Redo mode: only re-process filings already OCR'd by the named provider (replace their rows);
  // skip everything else (new candidates and other providers). Otherwise: skip already-ingested.
  const skipFn = args.redo ? (id: string) => filingOcrProvider(id) !== args.redo : hasFiling;
  if (args.redo) log(`OCR redo mode: re-processing filings with ocr_provider='${args.redo}' (replacing rows)`);

  const sources: Array<[string, AsyncGenerator<OcrCandidate>]> = [];
  if (args.source === "all" || args.source === "senate") {
    sources.push([
      "Senate paper",
      scrapeSenatePaper({ startDate: args.start, maxFilings: args.max, skip: skipFn, log, filer: args.filer }),
    ]);
  }
  if (args.source === "all" || args.source === "house") {
    sources.push([
      "House scanned",
      scrapeHouseScanned({ year: args.year, maxFilings: args.max, skip: skipFn, log, filer: args.filer }),
    ]);
  }

  let candidates = 0;
  let filings = 0;
  let trades = 0;
  let review = 0;
  let failed = 0;
  let aborted = false;

  for (const [label, gen] of sources) {
    for await (const c of gen) {
      candidates++;
      const who = `${c.member.firstName} ${c.member.lastName}`.replace(/\s+/g, " ").trim();

      if (args.dryRun) {
        log(`[dry-run] ${label}: ${who} — ${c.filing.id} <- ${c.filing.sourceUrl}`);
        continue;
      }

      try {
        const raw = await c.loadPages();
        const pages: Buffer[] = [];
        for (const p of raw) pages.push((await preprocessPage(p)).buffer);
        const extracted = await extractChunked(provider!, pages, {
          maxPagesPerChunk: args.chunk,
          spacingMs: args.chunkSpacing * 1000,
          onLog: log,
        });
        const validated = validateExtraction(extracted, {
          filingDate: c.filing.filedDate,
          expectedFiler: who,
        });
        const r = ingestOcrFiling({
          member: c.member,
          filing: c.filing,
          provider: provider!.name,
          extracted,
          validated,
          replace: !!args.redo,
        });
        if (r.inserted) {
          filings++;
          trades += r.trades;
          review += r.review;
          log(`${label}: ${who} ${c.filing.id} — ${r.trades} trades accepted, ${r.review} to review`);
        }
      } catch (err) {
        if (isQuotaError(err)) {
          log(
            `\n${label}: ABORTING — provider credits/quota exhausted. Top up the provider or set ` +
              `OCR_PROVIDER to a funded one, then re-run (incremental: already-ingested filings are skipped).`,
          );
          aborted = true;
          break;
        }
        failed++;
        log(`${label}: failed ${c.filing.id}: ${(err as Error).message}`);
      }
    }
    if (aborted) break;
  }

  if (args.dryRun) {
    console.log(`\nOCR dry-run: ${candidates} candidate filing(s) would be processed.`);
  } else {
    console.log(
      `\nOCR (${provider!.name}): ${filings} filing(s) ingested — ` +
        `${trades} trades auto-accepted, ${review} parked for review, ${failed} failed.`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => console.log(m);

  if (args.ocr) {
    console.log(
      `OCR source=${args.source} max=${args.max} year=${args.year}` +
        (args.dryRun ? " (dry-run)" : ""),
    );
    await runOcr(args);
    console.log("\nDone.");
    return;
  }

  console.log(`Scraping source=${args.source} max=${args.max} year=${args.year}`);

  if (args.source === "all" || args.source === "senate") {
    await ingestAll(
      "Senate",
      scrapeSenate({ startDate: args.start, maxFilings: args.max, skip: hasFiling, log, filer: args.filer }),
    );
  }
  if (args.source === "all" || args.source === "house") {
    await ingestAll(
      "House",
      scrapeHouse({ year: args.year, maxFilings: args.max, skip: hasFiling, log, filer: args.filer }),
    );
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
