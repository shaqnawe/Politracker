import { resolvedCompanies } from "../db.js";

/**
 * Deterministic ticker extraction from statement text — for Model A. NEVER fabricates a mention:
 * a ticker is emitted only when a concrete token is present —
 *   1. a cashtag ($AAPL),
 *   2. an explicit parenthesised symbol "(AAPL)" that is in the SEC company universe, or
 *   3. a company NAME that matches a curated alias or a multi-word universe name.
 * Single bare common words are deliberately NOT matched as names (too many false positives) — they
 * need a cashtag/explicit symbol. Each mention carries a method + confidence so the model can weight
 * or filter (cashtags are the most reliable).
 */

// High-precision aliases for names people actually say (and which clean to a single token).
const ALIASES: Record<string, string> = {
  apple: "AAPL", microsoft: "MSFT", amazon: "AMZN", google: "GOOGL", alphabet: "GOOGL",
  tesla: "TSLA", nvidia: "NVDA", meta: "META", facebook: "META", netflix: "NFLX",
  berkshire: "BRK.B", "berkshire hathaway": "BRK.B", jpmorgan: "JPM", "jp morgan": "JPM",
  "goldman sachs": "GS", goldman: "GS", boeing: "BA", exxon: "XOM", exxonmobil: "XOM",
  chevron: "CVX", pfizer: "PFE", moderna: "MRNA", intel: "INTC", amd: "AMD",
  palantir: "PLTR", coinbase: "COIN", "trump media": "DJT", "truth social": "DJT",
  disney: "DIS", walmart: "WMT", "bank of america": "BAC", "general motors": "GM",
  starbucks: "SBUX", mcdonalds: "MCD", mcdonald: "MCD", "lockheed martin": "LMT", lockheed: "LMT",
  "home depot": "HD", costco: "COST", "eli lilly": "LLY", lilly: "LLY",
};

const SUFFIXES =
  /\b(incorporated|inc|corporation|corp|company|co|holdings?|group|plc|ltd|limited|sa|nv|ag|llc|class [a-c]|the)\b/g;

/** Normalise a company name to a comparable core ("Apple Inc." → "apple"). */
function cleanName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Extractor {
  universe: Set<string>;
  names: { name: string; ticker: string }[]; // longest-first for greedy matching
}

/** Build the extractor from the SEC-resolved company universe + curated aliases. */
export function buildExtractor(): Extractor {
  const universe = new Set<string>();
  const nameIndex = new Map<string, string>();
  for (const c of resolvedCompanies()) {
    const tk = c.ticker.toUpperCase();
    universe.add(tk);
    if (!c.name) continue;
    const core = cleanName(c.name);
    // Only multi-word universe names are precise enough to match as bare text.
    if (core.split(" ").length >= 2 && core.length >= 7 && !nameIndex.has(core)) nameIndex.set(core, tk);
  }
  for (const [name, tk] of Object.entries(ALIASES)) {
    nameIndex.set(name, tk);
    universe.add(tk);
  }
  const names = [...nameIndex.entries()]
    .map(([name, ticker]) => ({ name, ticker }))
    .sort((a, b) => b.name.length - a.name.length);
  return { universe, names };
}

export interface Mention {
  ticker: string;
  company_name: string | null;
  method: "cashtag" | "explicit" | "name";
  confidence: number;
}

/** Extract all distinct ticker mentions from text (highest-confidence method wins per ticker). */
export function extractMentions(text: string, ex: Extractor): Mention[] {
  const found = new Map<string, Mention>();
  const consider = (m: Mention) => {
    const cur = found.get(m.ticker);
    if (!cur || m.confidence > cur.confidence) found.set(m.ticker, m);
  };

  for (const mt of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const tk = mt[1].toUpperCase();
    consider({ ticker: tk, company_name: null, method: "cashtag", confidence: ex.universe.has(tk) ? 0.9 : 0.55 });
  }
  for (const mt of text.matchAll(/\(([A-Z]{1,5})\)/g)) {
    const tk = mt[1].toUpperCase();
    if (ex.universe.has(tk)) consider({ ticker: tk, company_name: null, method: "explicit", confidence: 0.85 });
  }
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ")} `;
  for (const { name, ticker } of ex.names) {
    if (hay.includes(` ${name} `)) {
      consider({ ticker, company_name: name, method: "name", confidence: name.includes(" ") ? 0.7 : 0.8 });
    }
  }
  return [...found.values()];
}
