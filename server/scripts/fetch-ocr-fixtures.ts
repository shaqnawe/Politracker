/**
 * One-off: download a sample of the SCANNED House PTRs — the ones with a DocID
 * starting with "8" that the scraper deliberately skips — into src/ocr/fixtures/
 * so the OCR eval harness (STEP 2) has real ground-truth documents to score against.
 *
 * Saves PDFs only; it ingests nothing into the DB. Reuses the existing House index
 * logic and the rate-limited HTTP client.
 *
 *   npx tsx scripts/fetch-ocr-fixtures.ts [--year=2024] [--limit=20]
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HttpClient } from "../src/util/http.js";
import { loadHouseIndex, ptrPdfUrl, type IndexEntry } from "../src/scrapers/house.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, "../src/ocr/fixtures");

function arg(name: string, fallback: string): string {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? fallback;
}

/** member + DocID, e.g. "khanna-rohit-ca17-8220691.pdf". */
function fixtureName(e: IndexEntry): string {
  const slug = [e.last, e.first, e.stateDst]
    .join("-")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug}-${e.docId}.pdf`;
}

async function main() {
  const year = Number(arg("year", "2024"));
  const limit = Number(arg("limit", "20"));

  const http = new HttpClient({ minDelayMs: 1000 });
  console.log(`Loading ${year} House disclosure index...`);
  const index = await loadHouseIndex(http, year);

  // The scraper keeps DocID "2..." (online, text). Here we want exactly what it
  // skips: periodic transaction reports filed on paper / scanned (DocID "8...").
  const scanned = index.filter((e) => e.filingType === "P" && e.docId.startsWith("8"));
  console.log(`Found ${scanned.length} scanned PTRs in ${year}.`);

  // Prefer variety: one filing per member first (different members tend to use
  // different form layouts), then top up with extras until we reach the limit.
  const byMember = new Map<string, IndexEntry>();
  for (const e of scanned) {
    const key = `${e.last}|${e.first}|${e.stateDst}`;
    if (!byMember.has(key)) byMember.set(key, e);
  }
  const selected: IndexEntry[] = [...byMember.values()];
  const chosen = new Set(selected.map((e) => e.docId));
  for (const e of scanned) {
    if (selected.length >= limit) break;
    if (!chosen.has(e.docId)) {
      selected.push(e);
      chosen.add(e.docId);
    }
  }
  selected.length = Math.min(selected.length, limit);

  mkdirSync(FIXTURES_DIR, { recursive: true });
  let saved = 0;
  let skipped = 0;
  for (const e of selected) {
    const name = fixtureName(e);
    const dest = resolve(FIXTURES_DIR, name);
    if (existsSync(dest)) {
      console.log(`skip   ${name} (already present)`);
      skipped++;
      continue;
    }
    const buf = await http.buffer(ptrPdfUrl(year, e.docId));
    writeFileSync(dest, buf);
    console.log(`saved  ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
    saved++;
  }
  console.log(`\nDone. ${saved} downloaded, ${skipped} already present -> ${FIXTURES_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
