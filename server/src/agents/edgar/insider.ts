import { secHttp } from "../companies.js";
import {
  insertInsiderTrade,
  resolvedCompaniesByActivity,
  setCompanyForm4At,
} from "../db.js";
import { parseForm4, txTypeFromCode } from "./form4.js";

/**
 * EDGAR Form 4 insider-trades collector (deterministic). For each resolved company (scoped by how
 * often the ticker is traded), read its SEC submissions feed, pick the Form 4 filings newer than
 * our last scan (or the lookback window), fetch + parse each ownership XML, and store its
 * non-derivative transactions. Idempotent: row ids are accession+index (INSERT OR IGNORE), and
 * each company's last-scan date advances the incremental cutoff. Safe to re-run / cron.
 */
interface SubmissionsRecent {
  form: string[];
  accessionNumber: string[];
  filingDate: string[];
  primaryDocument: string[];
}

export interface InsiderOptions {
  /** Cap how many companies to scan (most-traded first). Default: all resolved. */
  maxCompanies?: number;
  /** How far back to look on the first scan of a company. Default 7 days (daily-cron cadence). */
  lookbackDays?: number;
  log?: (msg: string) => void;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export async function collectInsiderTrades(
  opts: InsiderOptions = {},
): Promise<{ companies: number; filings: number; rows: number }> {
  const log = opts.log ?? (() => {});
  const lookbackBase = isoDaysAgo(opts.lookbackDays ?? 7);
  const companies = resolvedCompaniesByActivity(opts.maxCompanies);
  const http = secHttp();

  log(`Insider: scanning Form 4 for ${companies.length} companies (since ${lookbackBase} or last scan)…`);
  let filings = 0;
  let rows = 0;

  for (const co of companies) {
    if (!co.cik) continue;
    // Incremental cutoff: the later of the lookback window and this company's last scan.
    const cutoff = co.last_form4_at && co.last_form4_at > lookbackBase ? co.last_form4_at : lookbackBase;

    let sub: { filings: { recent: SubmissionsRecent } };
    try {
      sub = await http.json(`https://data.sec.gov/submissions/CIK${co.cik}.json`);
    } catch (err) {
      log(`Insider: ${co.ticker} submissions failed: ${(err as Error).message}`);
      continue;
    }

    const r = sub.filings.recent;
    const idxs: number[] = [];
    for (let i = 0; i < r.form.length; i++) {
      if (r.form[i] === "4" && r.filingDate[i] > cutoff) idxs.push(i);
    }

    for (const i of idxs) {
      const accession = r.accessionNumber[i];
      const accNoDash = accession.replace(/-/g, "");
      const base = r.primaryDocument[i].split("/").pop(); // drop the xslF345…/ render prefix
      if (!base) continue;
      const url = `https://www.sec.gov/Archives/edgar/data/${Number(co.cik)}/${accNoDash}/${base}`;

      let xml: string;
      try {
        xml = await http.text(url);
      } catch (err) {
        log(`Insider: ${co.ticker} ${accession} fetch failed: ${(err as Error).message}`);
        continue;
      }

      const form4 = parseForm4(xml);
      if (!form4) {
        log(`Insider: ${co.ticker} ${accession} not an ownership document — skipped`);
        continue;
      }
      filings++;

      form4.transactions.forEach((t, j) => {
        const value = t.shares != null && t.price != null ? t.shares * t.price : null;
        const inserted = insertInsiderTrade({
          id: `${accession}-${j}`,
          ticker: co.ticker,
          cik: co.cik,
          accession,
          insiderName: form4.ownerName,
          insiderTitle: form4.ownerTitle,
          relationship: form4.relationship,
          securityTitle: t.securityTitle,
          txCode: t.txCode,
          txType: txTypeFromCode(t.txCode),
          acquiredDisposed: t.acquiredDisposed,
          txDate: t.txDate,
          shares: t.shares,
          price: t.price,
          value,
          sourceUrl: url,
        });
        if (inserted) rows++;
      });
    }

    setCompanyForm4At(co.ticker, todayIso());
    if (idxs.length) log(`Insider: ${co.ticker} — ${idxs.length} new Form 4(s)`);
  }

  log(`Insider: ${rows} transactions from ${filings} filings across ${companies.length} companies.`);
  return { companies: companies.length, filings, rows };
}
