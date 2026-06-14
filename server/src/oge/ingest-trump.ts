/**
 * OGE collector — President's annual OGE Form 278e public financial disclosure (holdings snapshot).
 * Downloads the official PDF from oge.gov, extracts its text, parses Schedule A, and ingests the
 * CURATED public-market holdings (stocks / ETFs / funds / Treasuries) for the President as an
 * `executive`-chamber member. Bonds and private/business entities are intentionally NOT itemized
 * (counted only), so the snapshot stays high-signal for a market tracker.
 *
 * Official, free source → fits the project's source rule. Holdings are a yearly SNAPSHOT in RANGES,
 * NOT dated trades — stored in `holdings`, never `trades`.
 *
 *   npx tsx src/oge/ingest-trump.ts                 (download + ingest)
 *   npx tsx src/oge/ingest-trump.ts --pdf=PATH      (use a local PDF instead of downloading)
 *   npx tsx src/oge/ingest-trump.ts --dry-run       (parse + report, no DB writes)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMember, ingestHoldings, type HoldingInput } from "../db.js";
import { parse278eHoldings, type AssetClass } from "./parse278e.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (b: Buffer) => Promise<{ text: string; numpages: number }>;

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- The filing: President's 2025 Annual 278e (covers CY2024), from the OGE PAS index. ---
const MEMBER = {
  id: "executive-trump-donald",
  chamber: "executive",
  firstName: "Donald J.",
  lastName: "Trump",
};
const REPORT_YEAR = 2025;
const SOURCE_URL =
  "https://extapps2.oge.gov/201/Presiden.nsf/PAS+Index/4EC9A8E6DD078F2985258CA9002C9377/$FILE/Trump,%20Donald%20J.%202025%20Annual%20278.pdf";

// Curated public-market classes shown in the app; everything else is counted but not itemized.
const CURATED: AssetClass[] = ["stock", "etf", "fund", "treasury"];

const dryRun = process.argv.includes("--dry-run");
const pdfArg = process.argv.find((a) => a.startsWith("--pdf="))?.split("=")[1];

async function loadPdfBuffer(): Promise<Buffer> {
  if (pdfArg) return readFileSync(pdfArg);
  const cacheDir = resolve(__dirname, "../../data/oge-cache");
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = resolve(cacheDir, "trump-2025-278e.pdf");
  if (existsSync(cachePath)) {
    console.log(`Using cached PDF: ${cachePath}`);
    return readFileSync(cachePath);
  }
  console.log(`Downloading 278e from oge.gov…`);
  const res = await fetch(SOURCE_URL, { headers: { "User-Agent": "politracker/1.0 (research)" } });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cachePath, buf);
  console.log(`Saved ${(buf.length / 1e6).toFixed(1)}MB → ${cachePath}`);
  return buf;
}

async function main() {
  const buf = await loadPdfBuffer();
  const { text, numpages } = await pdfParse(buf);
  const all = parse278eHoldings(text);

  const counts: Record<string, number> = {};
  for (const h of all) counts[h.assetClass] = (counts[h.assetClass] ?? 0) + 1;

  const curated: HoldingInput[] = all
    .filter((h) => CURATED.includes(h.assetClass))
    .map((h) => ({
      assetName: h.assetName,
      ticker: h.ticker,
      assetClass: h.assetClass,
      valueMin: h.valueMin,
      valueMax: h.valueMax,
      valueLabel: h.valueLabel,
      incomeType: h.incomeType,
      incomeLabel: h.incomeLabel,
    }));

  console.log(`\nParsed ${all.length} Schedule A rows from ${numpages} pages.`);
  console.log("By class:", counts);
  console.log(
    `\nCURATED public holdings to ingest: ${curated.length}  (${CURATED.join("/")})\n` +
      `  excluded (counted, not itemized): corp_bond=${counts.corp_bond ?? 0}, ` +
      `muni_bond=${counts.muni_bond ?? 0}, private/other=${counts.other ?? 0}`,
  );

  if (dryRun) {
    console.log("\n[dry-run] no DB writes.");
    return;
  }

  ensureMember({ ...MEMBER, sourceUrl: SOURCE_URL });
  const n = ingestHoldings({
    memberId: MEMBER.id,
    reportType: "annual_278e",
    reportYear: REPORT_YEAR,
    sourceUrl: SOURCE_URL,
    holdings: curated,
  });
  console.log(`\nIngested ${n} holdings for ${MEMBER.firstName} ${MEMBER.lastName} (${MEMBER.id}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
