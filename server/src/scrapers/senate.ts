import * as cheerio from "cheerio";
import { HttpClient } from "../util/http.js";
import { matchesFiler } from "./house.js";
import {
  cleanName,
  extractTicker,
  parseAmount,
  parseOwner,
  parseTxType,
  toIsoDate,
} from "../util/parse.js";
import type { OcrCandidate, ScrapedFiling, TradeInput } from "../util/types.js";

const BASE = "https://efdsearch.senate.gov";
const HOME = `${BASE}/search/home/`;
const DATA = `${BASE}/search/report/data/`;

// Report type 11 = Periodic Transaction Report (the stock trades).
const REPORT_TYPE_PTR = 11;

export interface SenateOptions {
  /** Earliest filing date to fetch, MM/DD/YYYY. */
  startDate?: string;
  /** Stop after collecting this many new filings. */
  maxFilings?: number;
  /** Return true to skip a filing we already have (avoids fetching its detail page). */
  skip?: (filingId: string) => boolean;
  log?: (msg: string) => void;
  /** Only process filers whose name contains this substring (case-insensitive). For targeted backfills. */
  filer?: string;
}

interface ReportRow {
  firstName: string;
  lastName: string;
  filedDate: string | null;
  detailUrl: string;
  uuid: string;
  isElectronic: boolean;
}

/**
 * The eFD site requires accepting a usage agreement before any search works.
 * This establishes the csrftoken cookie + a session cookie carrying the agreement.
 */
async function acceptAgreement(http: HttpClient): Promise<string> {
  const home = await http.text(HOME);
  const token =
    home.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/)?.[1] ??
    http.getCookie("csrftoken");
  if (!token) throw new Error("Senate: could not find CSRF token on home page");

  const form = new URLSearchParams();
  form.set("prohibition_agreement", "1");
  form.set("csrfmiddlewaretoken", token);

  await http.request(HOME, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": http.getCookie("csrftoken") ?? token,
      Referer: HOME,
    },
    body: form.toString(),
  });

  const csrf = http.getCookie("csrftoken");
  if (!csrf) throw new Error("Senate: no csrftoken cookie after agreement");
  return csrf;
}

/** Page through the report-search JSON endpoint, yielding PTR rows newest-first. */
async function* listReports(
  http: HttpClient,
  csrf: string,
  startDate: string,
): AsyncGenerator<ReportRow> {
  const pageSize = 100;
  let start = 0;
  while (true) {
    const form = new URLSearchParams();
    form.set("draw", "1");
    form.set("start", String(start));
    form.set("length", String(pageSize));
    form.set("report_types", `[${REPORT_TYPE_PTR}]`);
    form.set("filer_types", "[]");
    form.set("submitted_start_date", `${startDate} 00:00:00`);
    form.set("submitted_end_date", "");
    form.set("candidate_state", "");
    form.set("senator_state", "");
    form.set("office_id", "");
    form.set("first_name", "");
    form.set("last_name", "");
    form.set("csrfmiddlewaretoken", csrf);

    const json = await http.json<{ data: string[][]; recordsTotal: number }>(DATA, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRFToken": csrf,
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE}/search/`,
      },
      body: form.toString(),
    });

    const rows = json.data ?? [];
    if (rows.length === 0) return;

    for (const row of rows) {
      // row = [firstName, lastName, fullNameLabel, "<a href=...>...</a>", "MM/DD/YYYY"]
      const [firstName, lastName, , linkHtml, filed] = row;
      const href = linkHtml.match(/href="([^"]+)"/)?.[1];
      if (!href) continue;
      const uuid = href.match(/\/(ptr|paper)\/([0-9a-f-]+)\//i)?.[2];
      if (!uuid) continue;
      yield {
        firstName: (firstName || "").trim(),
        lastName: (lastName || "").trim(),
        filedDate: toIsoDate(filed),
        detailUrl: new URL(href, BASE).toString(),
        uuid: `senate-${uuid}`,
        isElectronic: /\/ptr\//i.test(href),
      };
    }

    start += pageSize;
    if (start >= (json.recordsTotal ?? 0)) return;
  }
}

/** Parse the transaction table out of an electronic PTR HTML page. */
function parsePtrHtml(html: string): TradeInput[] {
  const $ = cheerio.load(html);
  const trades: TradeInput[] = [];

  $("table tbody tr").each((_, tr) => {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => $(td).text().replace(/\s+/g, " ").trim());
    // Columns: #, Tx Date, Owner, Ticker, Asset Name, Asset Type, Type, Amount, Comment
    if (cells.length < 8) return;

    const assetName = cells[4] || "";
    if (!assetName) return;
    const tickerCell = cells[3] && cells[3] !== "--" ? cells[3] : null;
    const amount = parseAmount(cells[7]);

    trades.push({
      transactionDate: toIsoDate(cells[1]),
      owner: parseOwner(cells[2]),
      ticker: tickerCell ?? extractTicker(assetName),
      assetName,
      assetType: cells[5] && cells[5] !== "--" ? cells[5] : null,
      txType: parseTxType(cells[6]),
      amountMin: amount.min,
      amountMax: amount.max,
      amountLabel: cells[7] || "",
      comment: cells[8] && cells[8] !== "--" ? cells[8] : null,
    });
  });

  return trades;
}

/** Scrape Senate PTRs, yielding one normalized filing at a time. */
export async function* scrapeSenate(opts: SenateOptions = {}): AsyncGenerator<ScrapedFiling> {
  const log = opts.log ?? (() => {});
  const startDate = opts.startDate ?? "01/01/2024";
  const maxFilings = opts.maxFilings ?? 60;

  const http = new HttpClient({ minDelayMs: 1000 });
  log("Senate: accepting eFD usage agreement…");
  const csrf = await acceptAgreement(http);

  let collected = 0;
  for await (const row of listReports(http, csrf, startDate)) {
    if (collected >= maxFilings) break;
    if (!matchesFiler(opts.filer, row.firstName, row.lastName)) continue;
    if (opts.skip?.(row.uuid)) continue;
    if (!row.isElectronic) continue; // paper filings are scanned PDFs; skipped in v1

    let trades: TradeInput[] = [];
    try {
      const html = await http.text(row.detailUrl, { headers: { Referer: `${BASE}/search/` } });
      trades = parsePtrHtml(html);
    } catch (err) {
      log(`Senate: failed to parse ${row.detailUrl}: ${(err as Error).message}`);
      continue;
    }

    collected++;
    log(`Senate: ${row.firstName} ${row.lastName} — ${trades.length} trades (${row.filedDate})`);
    yield {
      member: {
        chamber: "senate",
        firstName: cleanName(row.firstName),
        lastName: cleanName(row.lastName),
        state: null,
        district: null,
        sourceUrl: row.detailUrl,
      },
      filing: {
        id: row.uuid,
        chamber: "senate",
        filedDate: row.filedDate,
        sourceUrl: row.detailUrl,
      },
      trades,
    };
  }
}

/**
 * Load a Senate paper PTR's scanned pages. Paper filings aren't PDFs — the detail page renders
 * the scan as one GIF per page (`<img class="filingImage">`) hosted on efd-media-public.senate.gov.
 * We collect those page-image URLs in document order and download them as raw page images.
 */
export async function loadPaperPages(http: HttpClient, detailUrl: string): Promise<Buffer[]> {
  const html = await http.text(detailUrl, { headers: { Referer: `${BASE}/search/` } });
  const urls: string[] = [];
  const imgs = html.match(/<img\b[^>]*\bclass="[^"]*filingImage[^"]*"[^>]*>/gi) ?? [];
  for (const tag of imgs) {
    const src = tag.match(/\bsrc="([^"]+)"/i)?.[1];
    if (src) urls.push(new URL(src, BASE).toString());
  }
  if (urls.length === 0) throw new Error(`no scanned page images found on paper filing ${detailUrl}`);

  const pages: Buffer[] = [];
  for (const u of urls) pages.push(await http.buffer(u, { headers: { Referer: detailUrl } }));
  return pages;
}

/**
 * Surface Senate PAPER PTRs — the scanned filings scrapeSenate skips (isElectronic === false) —
 * as OCR candidates. Reuses the same agreement + listing flow; `download()` resolves the scanned
 * PDF from the detail page on demand. Incremental via `skip`: already-ingested filings are passed
 * over before the detail page is even fetched.
 */
export async function* scrapeSenatePaper(opts: SenateOptions = {}): AsyncGenerator<OcrCandidate> {
  const log = opts.log ?? (() => {});
  const startDate = opts.startDate ?? "01/01/2024";
  const maxFilings = opts.maxFilings ?? 50;

  const http = new HttpClient({ minDelayMs: 1000 });
  log("Senate OCR: accepting eFD usage agreement…");
  const csrf = await acceptAgreement(http);

  let collected = 0;
  for await (const row of listReports(http, csrf, startDate)) {
    if (collected >= maxFilings) break;
    if (!matchesFiler(opts.filer, row.firstName, row.lastName)) continue;
    if (row.isElectronic) continue; // electronic PTRs go through scrapeSenate (HTML, no OCR)
    if (opts.skip?.(row.uuid)) continue;

    collected++;
    yield {
      member: {
        chamber: "senate",
        firstName: cleanName(row.firstName),
        lastName: cleanName(row.lastName),
        state: null,
        district: null,
        sourceUrl: row.detailUrl,
      },
      filing: {
        id: row.uuid,
        chamber: "senate",
        filedDate: row.filedDate,
        sourceUrl: row.detailUrl,
      },
      loadPages: () => loadPaperPages(http, row.detailUrl),
    };
  }
}
