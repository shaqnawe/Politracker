import { HttpClient } from "../util/http.js";
import { tickerUniverse, upsertCompany } from "./db.js";

/**
 * Resolve the traded-ticker universe to SEC CIKs — the join that bounds every later EDGAR fetch.
 * Source is SEC's free, official ticker→CIK file. Unresolved tickers (funds, options, odd symbols)
 * are stored with cik=null and flagged, never guessed.
 */
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

/**
 * SEC's fair-access policy returns 403 unless the User-Agent is a real contact in "Name email"
 * form (a parenthetical/URL UA is rejected — verified empirically), and allows up to 10 req/s.
 * Set EDGAR_USER_AGENT="Your Name your@email" in .env for production; the placeholder default is
 * accepted in form but should be replaced so SEC can reach the operator about traffic.
 */
export function secHttp(): HttpClient {
  const ua = process.env.EDGAR_USER_AGENT;
  if (!ua) {
    console.warn(
      '[edgar] EDGAR_USER_AGENT not set — using a placeholder contact. SEC requires a real one; ' +
        'set EDGAR_USER_AGENT="Your Name your@email" in .env for production.',
    );
  }
  return new HttpClient({
    minDelayMs: 200,
    userAgent: ua ?? "PoliTracker dev contact@politracker.example.com",
  });
}

interface SecTicker {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Download SEC's ticker→CIK table as an UPPERCASE-ticker → { cik (10-digit), name } map. */
export async function loadSecTickerMap(http: HttpClient): Promise<Map<string, { cik: string; name: string }>> {
  const raw = await http.json<Record<string, SecTicker>>(TICKERS_URL);
  const map = new Map<string, { cik: string; name: string }>();
  for (const row of Object.values(raw)) {
    if (!row?.ticker) continue;
    map.set(row.ticker.toUpperCase(), { cik: String(row.cik_str).padStart(10, "0"), name: row.title });
  }
  return map;
}

/**
 * Look a ticker up in SEC's map, tolerating share-class punctuation: our trade data uses dots
 * (BRK.B) while SEC uses hyphens (BRK-B). Tries the verbatim ticker, then both variants.
 */
function lookupTicker(
  map: Map<string, { cik: string; name: string }>,
  ticker: string,
): { cik: string; name: string } | null {
  const u = ticker.toUpperCase();
  return map.get(u) ?? map.get(u.replace(/\./g, "-")) ?? map.get(u.replace(/-/g, ".")) ?? null;
}

export interface ResolveResult {
  total: number;
  resolved: number;
  unresolved: string[];
}

/** Upsert a companies row for every traded ticker, attaching its CIK where SEC knows it. */
export async function resolveCompanies(log: (msg: string) => void = () => {}): Promise<ResolveResult> {
  const tickers = tickerUniverse();
  log(`Companies: resolving ${tickers.length} tickers from the trade universe…`);

  const map = await loadSecTickerMap(secHttp());
  let resolved = 0;
  const unresolved: string[] = [];
  for (const ticker of tickers) {
    const hit = lookupTicker(map, ticker);
    upsertCompany({ ticker, cik: hit?.cik ?? null, name: hit?.name ?? null });
    if (hit) resolved++;
    else unresolved.push(ticker);
  }

  log(`Companies: ${resolved}/${tickers.length} resolved to a CIK; ${unresolved.length} unresolved.`);
  if (unresolved.length) log(`  unresolved (flagged, not guessed): ${unresolved.slice(0, 20).join(", ")}${unresolved.length > 20 ? " …" : ""}`);
  return { total: tickers.length, resolved, unresolved };
}
