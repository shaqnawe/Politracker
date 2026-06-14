import type { Owner, TxType } from "./types.js";

/**
 * Parse a disclosed dollar range into [min, max].
 * Disclosures report amounts as ranges, e.g. "$1,001 - $15,000", or open-ended
 * like "Over $50,000,000". Returns nulls when nothing numeric is found.
 */
export function parseAmount(raw: string): { min: number | null; max: number | null } {
  const text = (raw || "").replace(/\u00A0/g, " ").trim();
  const nums = (text.match(/\$\s*([\d,]+)/g) || [])
    .map((m) => Number(m.replace(/[^\d]/g, "")))
    .filter((n) => Number.isFinite(n));

  if (nums.length === 0) return { min: null, max: null };
  if (nums.length === 1) {
    // "Over $X" / "At least $X" => open top end; otherwise a single point value.
    const openEnded = /\b(over|more than|at least|greater than)\b/i.test(text);
    return openEnded ? { min: nums[0], max: null } : { min: nums[0], max: nums[0] };
  }
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

/** Normalize the many owner spellings across House/Senate into one set. */
export function parseOwner(raw: string | null | undefined): Owner {
  const t = (raw || "").trim().toLowerCase();
  if (!t || t === "--") return "unknown";
  if (t.startsWith("sp")) return "spouse";
  if (t.startsWith("jt") || t.startsWith("joint")) return "joint";
  // "dc", "dependent", "dependent_child", and OCR typos like "dependen_child" / "dep child".
  if (t.startsWith("dc") || t.startsWith("dep") || t.includes("dependent") || t.includes("child"))
    return "dependent";
  if (t.startsWith("self") || t.includes("filer")) return "self";
  return "unknown";
}

/**
 * Normalize transaction type. Senate uses words ("Purchase", "Sale (Full)"),
 * House PTR PDFs use single letters (P, S, E, and "S (partial)").
 */
export function parseTxType(raw: string | null | undefined): TxType {
  const t = (raw || "").trim().toLowerCase();
  if (!t) return "other";
  if (t.includes("partial")) return "sale_partial";
  if (t.includes("exchange") || t === "e") return "exchange";
  if (t.startsWith("p")) return "purchase";
  if (t.startsWith("s")) return "sale";
  return "other";
}

/** Pull a stock ticker out of an asset string, e.g. "Apple Inc. (AAPL) [ST]" -> "AAPL". */
export function extractTicker(assetName: string): string | null {
  // Prefer an explicit parenthesized symbol of 1-5 uppercase letters/digits.
  const m = assetName.match(/\(([A-Z][A-Z0-9.\-]{0,5})\)/);
  if (m && m[1] && m[1] !== "ST" && m[1] !== "OT") return m[1];
  return null;
}

/**
 * Company-name / legal fragments that OCR (and loose parsing) misread as a ticker but are NOT real
 * symbols — e.g. "The Walt Disney Co" → "THE", "...COM". Conservative on purpose: every entry is a
 * word that is not a listed U.S. equity ticker, so this never hides a real symbol (real word-like
 * tickers such as ALL, CAT, KEY, ON, SO are deliberately absent).
 */
export const ARTIFACT_TICKERS = new Set([
  "THE", "AND", "FOR", "COM", "INC", "CORP", "LLC", "LTD",
  "ETF", "FUND", "TRUST", "CLASS", "COMMON", "STOCK", "SHARES", "SERIES", "PLC", "ADR", "REIT",
]);

/** True when a "ticker" is actually one of the artifact words above (so it should be dropped). */
export function isArtifactTicker(ticker: string | null | undefined): boolean {
  return !!ticker && ARTIFACT_TICKERS.has(ticker.toUpperCase().trim());
}

/**
 * Convert "5/12/2024", "05/12/2024", or the 2-digit-year "5/12/24" to ISO "2024-05-12".
 * Scanned PTR forms write dates as MM/DD/YY, so a 2-digit year is mapped to 20YY (all STOCK
 * Act filings are post-2012; an out-of-range century is caught by the date-sanity window).
 * Also tolerates "." / "-" separators from OCR variance. Returns null if unparseable.
 */
export function toIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  const m = t.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})$/);
  if (m) {
    const [, mm, dd, yr] = m;
    const yyyy = yr.length === 2 ? `20${yr}` : yr;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "hon", "mr", "mrs", "ms", "dr"]);

// Honorifics and credentials the House index sometimes embeds in name fields,
// e.g. "Marjorie Taylor Mrs Greene" or "Dunn, MD, FACS".
const NAME_NOISE = new Set([
  "mr", "mrs", "ms", "miss", "dr", "hon", "rep", "sen", "prof",
  "md", "dds", "phd", "facs", "esq", "jd", "cpa", "rn", "do",
]);

/** Strip embedded honorifics/credentials from a name field for display. */
export function cleanName(raw: string): string {
  return (raw || "")
    .split(/\s+/)
    .map((w) => w.replace(/[.,]+$/, ""))
    .filter((w) => w && !NAME_NOISE.has(w.toLowerCase().replace(/[^a-z]/g, "")))
    .join(" ")
    .trim();
}

/** Build a stable, dedupe-friendly member id from chamber + name + locale. */
export function memberSlug(
  chamber: string,
  firstName: string,
  lastName: string,
  state: string | null,
  district: string | null,
): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !SUFFIXES.has(w))
      .join("-");
  // Identify a member by chamber + name + state only — NOT district. Districts change with
  // redistricting (e.g. Pelosi CA-12 -> CA-11), which must never split one person into two
  // member records. `district` is still stored on the row; it just isn't part of the id.
  const locale = (state ?? "").toLowerCase() || "na";
  return [chamber, clean(lastName), clean(firstName), locale].filter(Boolean).join("-");
}
