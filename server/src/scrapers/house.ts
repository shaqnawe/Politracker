import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { createRequire } from "node:module";
import { rasterizePdf } from "../ocr/preprocess.js";
import { HttpClient } from "../util/http.js";
import {
  cleanName,
  extractTicker,
  parseAmount,
  parseOwner,
  parseTxType,
  toIsoDate,
} from "../util/parse.js";
import type { OcrCandidate, ScrapedFiling, TradeInput } from "../util/types.js";

// pdf-parse is CommonJS and ships a debug harness in its index; require the lib entry directly.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (b: Buffer) => Promise<{ text: string }>;

const BASE = "https://disclosures-clerk.house.gov";
const indexZipUrl = (year: number) => `${BASE}/public_disc/financial-pdfs/${year}FD.ZIP`;
export const ptrPdfUrl = (year: number, docId: string) =>
  `${BASE}/public_disc/ptr-pdfs/${year}/${docId}.pdf`;

export interface HouseOptions {
  year?: number;
  maxFilings?: number;
  skip?: (filingId: string) => boolean;
  log?: (msg: string) => void;
  /** Only process filers whose name contains this substring (case-insensitive). For targeted backfills. */
  filer?: string;
}

/** Name-substring match for the optional --filer scope. */
export function matchesFiler(filer: string | undefined, first: string, last: string): boolean {
  if (!filer) return true;
  const q = filer.toLowerCase();
  return `${first} ${last}`.toLowerCase().includes(q) || last.toLowerCase().includes(q);
}

export interface IndexEntry {
  prefix: string;
  last: string;
  first: string;
  suffix: string;
  filingType: string;
  stateDst: string;
  year: string;
  filingDate: string;
  docId: string;
}

function parseIndex(xml: string): IndexEntry[] {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
  const doc = parser.parse(xml) as { FinancialDisclosure?: { Member?: any[] } };
  const members = doc.FinancialDisclosure?.Member ?? [];
  const arr = Array.isArray(members) ? members : [members];
  return arr.map((m) => ({
    prefix: String(m.Prefix ?? "").trim(),
    last: String(m.Last ?? "").trim(),
    first: String(m.First ?? "").trim(),
    suffix: String(m.Suffix ?? "").trim(),
    filingType: String(m.FilingType ?? "").trim(),
    stateDst: String(m.StateDst ?? "").trim(),
    year: String(m.Year ?? "").trim(),
    filingDate: String(m.FilingDate ?? "").trim(),
    docId: String(m.DocID ?? "").trim(),
  }));
}

/**
 * Download and parse a year's House financial-disclosure index, returning every
 * entry (all filing types). Callers filter to what they need. Shared by the
 * scraper and the OCR-fixture fetcher so the ZIP/XML logic lives in one place.
 */
export async function loadHouseIndex(http: HttpClient, year: number): Promise<IndexEntry[]> {
  const zipBuf = await http.buffer(indexZipUrl(year));
  const zip = new AdmZip(zipBuf);
  const xmlEntry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith(".xml"));
  if (!xmlEntry) throw new Error("House: no XML found in index ZIP");
  return parseIndex(xmlEntry.getData().toString("utf8"));
}

/** "GA12" -> { state: "GA", district: "12" }; "GA" -> { state: "GA", district: null }. */
function splitStateDistrict(stateDst: string): { state: string | null; district: string | null } {
  const m = stateDst.match(/^([A-Z]{2})(\d+)?$/);
  if (!m) return { state: stateDst || null, district: null };
  return { state: m[1], district: m[2] ?? null };
}

/**
 * Parse the transaction table out of an online-filed House PTR's extracted text.
 *
 * The PDF text flattens the table, but every transaction row ends in a reliable
 * anchor: a transaction-type letter (P/S/E), an optional qualifier ("(partial)"),
 * two MM/DD/YYYY dates, then a dollar amount. We split on that anchor and recover the
 * asset (and owner) from the text immediately before it, stripping the cover page and
 * per-row "Filing Status"/"Subholding Owner" annotations.
 */
export function parseHousePtr(text: string): TradeInput[] {
  // pdf-parse pads letter-spaced labels with NUL bytes; turn those (and non-breaking
  // spaces) into spaces, then collapse whitespace runs.
  let flat = text.replace(/[\u0000\u00A0]/g, " ").replace(/\s+/g, " ");

  // Drop everything up to the end of the table's column header ("...Cap. Gains > $200?").
  // This removes the cover block ("Washington, DC 20515", "Name:...") that would otherwise
  // bleed into the first asset and false-match an owner code.
  flat = flat.replace(/^[\s\S]*?\$\s*200\s*\?/, " ");

  // Strip per-row letter-spaced labels ("F S : New", "S O : <trust>", "D : <desc>") that
  // trail each amount. The label is 1-3 single letters then a colon; for Filing Status we
  // also drop its short value so it doesn't stick to the next asset.
  flat = flat.replace(/(?:[A-Z]\s){1,3}:\s*(?:New|Amended|Partially Sold|Partial)?/g, " ");

  const anchor =
    /([PSE])\s*(\([^)]*\))?\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*(\$[\d,]+(?:\s*-\s*\$[\d,]+)?\s*\+?)/g;

  const trades: TradeInput[] = [];
  let prevEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(flat)) !== null) {
    const [, typeLetter, qualifier, txDate, , amountStr] = m;
    const window = flat.slice(prevEnd, m.index);
    prevEnd = anchor.lastIndex;

    // The owner code (SP/JT/DC/JO) is glued to the asset with no space, e.g.
    // "SPState Street Corp". Take the LAST such code in the window: text before it is
    // the previous row's leftover annotation, text after it is this row's asset.
    let owner = "self";
    let assetName: string;
    const ownerRe = /(SP|JT|DC|JO)(?=[A-Z])/g;
    let last: RegExpExecArray | null;
    let lastMatch: { code: string; end: number } | null = null;
    while ((last = ownerRe.exec(window)) !== null) {
      lastMatch = { code: last[1], end: last.index + last[1].length };
    }
    if (lastMatch) {
      owner = lastMatch.code;
      assetName = window.slice(lastMatch.end);
    } else {
      assetName = window;
    }

    assetName = assetName.replace(/\s+/g, " ").trim();
    if (!assetName || assetName.length < 2) continue;

    const assetType = assetName.match(/\[([A-Z]{1,3})\]\s*$/)?.[1] ?? null;
    assetName = assetName.replace(/\s*\[[A-Z]{1,3}\]\s*$/, "").trim();

    const amount = parseAmount(amountStr);
    trades.push({
      transactionDate: toIsoDate(txDate),
      owner: parseOwner(owner),
      ticker: extractTicker(assetName),
      assetName,
      assetType,
      txType: parseTxType(`${typeLetter}${qualifier ?? ""}`),
      amountMin: amount.min,
      amountMax: amount.max,
      amountLabel: amountStr.replace(/\s+/g, " ").trim(),
      comment: null,
    });
  }
  return trades;
}

/** Scrape House PTRs for a year, yielding one normalized filing at a time. */
export async function* scrapeHouse(opts: HouseOptions = {}): AsyncGenerator<ScrapedFiling> {
  const log = opts.log ?? (() => {});
  const year = opts.year ?? new Date().getFullYear();
  const maxFilings = opts.maxFilings ?? 60;

  const http = new HttpClient({ minDelayMs: 1000 });
  log(`House: downloading ${year} disclosure index...`);
  const entries = (await loadHouseIndex(http, year))
    .filter((e) => e.filingType === "P" && e.docId)
    // Online-filed PTRs (DocID starts with "2") have extractable text; "8..." are scanned.
    .filter((e) => e.docId.startsWith("2"))
    .filter((e) => matchesFiler(opts.filer, e.first, e.last))
    .sort((a, b) => b.docId.localeCompare(a.docId)); // newest-ish first

  log(`House: ${entries.length} online-filed PTRs in ${year}${opts.filer ? ` matching "${opts.filer}"` : ""}`);

  let collected = 0;
  for (const e of entries) {
    if (collected >= maxFilings) break;
    const filingId = `house-${e.docId}`;
    if (opts.skip?.(filingId)) continue;

    let trades: TradeInput[] = [];
    const url = ptrPdfUrl(year, e.docId);
    try {
      const pdfBuf = await http.buffer(url);
      const { text } = await pdfParse(pdfBuf);
      trades = parseHousePtr(text);
    } catch (err) {
      log(`House: failed ${e.docId}: ${(err as Error).message}`);
      continue;
    }

    const { state, district } = splitStateDistrict(e.stateDst);
    collected++;
    log(`House: ${e.first} ${e.last} (${e.stateDst}) - ${trades.length} trades`);
    yield {
      member: {
        chamber: "house",
        firstName: cleanName(e.first),
        lastName: cleanName(e.last),
        state,
        district,
        sourceUrl: url,
      },
      filing: {
        id: filingId,
        chamber: "house",
        filedDate: toIsoDate(e.filingDate),
        sourceUrl: url,
      },
      trades,
    };
  }
}

/**
 * Surface the SCANNED House PTRs (DocID "8…") that scrapeHouse deliberately skips, as OCR
 * candidates. Same index + PDF-URL path as the text scraper; the difference is these PDFs have
 * no extractable text, so the runner (STEP 7) rasterizes + OCRs them instead of parsing text.
 * Incremental via `skip` — already-ingested filings are passed over before any download.
 */
export async function* scrapeHouseScanned(opts: HouseOptions = {}): AsyncGenerator<OcrCandidate> {
  const log = opts.log ?? (() => {});
  const year = opts.year ?? new Date().getFullYear();
  const maxFilings = opts.maxFilings ?? 50;

  const http = new HttpClient({ minDelayMs: 1000 });
  log(`House OCR: downloading ${year} disclosure index…`);
  const entries = (await loadHouseIndex(http, year))
    .filter((e) => e.filingType === "P" && e.docId)
    .filter((e) => e.docId.startsWith("8")) // scanned/paper PTRs (online "2…" go through scrapeHouse)
    .filter((e) => matchesFiler(opts.filer, e.first, e.last))
    .sort((a, b) => b.docId.localeCompare(a.docId));

  log(`House OCR: ${entries.length} scanned PTRs in ${year}${opts.filer ? ` matching "${opts.filer}"` : ""}`);

  let collected = 0;
  for (const e of entries) {
    if (collected >= maxFilings) break;
    const filingId = `house-${e.docId}`;
    if (opts.skip?.(filingId)) continue;

    const url = ptrPdfUrl(year, e.docId);
    const { state, district } = splitStateDistrict(e.stateDst);
    collected++;
    yield {
      member: {
        chamber: "house",
        firstName: cleanName(e.first),
        lastName: cleanName(e.last),
        state,
        district,
        sourceUrl: url,
      },
      filing: {
        id: filingId,
        chamber: "house",
        filedDate: toIsoDate(e.filingDate),
        sourceUrl: url,
      },
      loadPages: async () => rasterizePdf(await http.buffer(url)),
    };
  }
}
