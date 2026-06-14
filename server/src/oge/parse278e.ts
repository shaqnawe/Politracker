/**
 * Parser for OGE Form 278e (annual public financial disclosure) Schedule A holdings, working off
 * the digital-text extraction of the PDF. The form is a holdings + income SNAPSHOT (not dated
 * transactions): each asset row carries an asset name, an EIF flag, a VALUE range, and optionally
 * an income type + income-amount range, e.g.
 *
 *     13
 *     MICROSOFT CORP COM
 *     N/A   None (or less than $1,001)DIVIDEND    $1,001 - $2,500
 *
 * The value/income brackets run together in the text dump, so we anchor on the unambiguous DATA
 * LINE (EIF flag + first value bracket) and take the asset name from the preceding line(s). Only
 * rows whose value bracket is a canonical OGE bucket are kept — anything we can't parse cleanly is
 * dropped, never guessed (consistent with the project's "null beats wrong" rule).
 */

export type AssetClass = "stock" | "etf" | "fund" | "treasury" | "muni_bond" | "corp_bond" | "other";

export interface Holding {
  assetName: string;
  ticker: string | null;
  assetClass: AssetClass;
  isPublic: boolean;
  valueLabel: string;
  valueMin: number | null;
  valueMax: number | null;
  incomeType: string | null;
  incomeLabel: string | null;
}

const VALUE_BRACKET = /(None \(or less than \$1,001\)|\$[\d,]+ - \$[\d,]+|Over \$[\d,]+)/;
// A row's data line: optional leading row number, EIF flag, then the first value bracket + the rest.
const DATA_LINE = /^\d*\s*(Yes|No|N\/A)\s+(None \(or less than \$1,001\)|\$[\d,]+ - \$[\d,]+|Over \$[\d,]+)(.*)$/;
const INCOME_TYPE = /(DIVIDEND|INTEREST|CAPITAL GAINS?|RENT|ROYALT(?:Y|IES)|PARTNERSHIP|TAX-DEFERRED)/;

// Lines that are page furniture / form scaffolding, never an asset name.
const NOISE = /^(Page \d|Filer'?s Name|Page Number|Instructions for|OGE Form|U\.S\. Office|Report Type|Year \(|Date of|Appointment Type|Executive Branch|Schedule [A-Z]|Description|EIF|Value|Income|\d+\.?$|#?\d+$|None$|N\/A$|Yes$|No$)/i;

function parseDollars(label: string): { min: number | null; max: number | null } {
  const l = label.trim();
  if (/^None/.test(l)) return { min: 0, max: 1001 };
  const over = l.match(/^Over \$([\d,]+)/);
  if (over) return { min: Number(over[1].replace(/,/g, "")), max: null };
  const range = l.match(/\$([\d,]+) - \$([\d,]+)/);
  if (range) return { min: Number(range[1].replace(/,/g, "")), max: Number(range[2].replace(/,/g, "")) };
  return { min: null, max: null };
}

/** Classify an asset by name, returning a clean display name where the raw text is mangled.
 *  Public-market = has a market price (stock/ETF/fund/treasury/bond). Order matters: ETFs and debt
 *  instruments are detected BEFORE the generic "COM" stock marker (e.g. AMAZON.COM is not a bond,
 *  but "AMAZON.COM, INC. 4.55% DUE 12/01/27" is). */
export function classify(name: string): {
  assetClass: AssetClass;
  isPublic: boolean;
  ticker: string | null;
  canonicalName?: string;
} {
  const n = name.toUpperCase();
  if (/TRUMP MEDIA & TECHNOLOGY/.test(n))
    return {
      assetClass: "stock",
      isPublic: true,
      ticker: "DJT",
      canonicalName: "Trump Media & Technology Group Corp. — common stock (DJT)",
    };
  if (/\bETF\b|EXCHANGE-TRADED|\bSPDR\b|ISHARES|VANGUARD|INVESCO/.test(n))
    return { assetClass: "etf", isPublic: true, ticker: null };
  if (/U S TREAS|UNITED STS TREAS|TREASURY (NOTE|BILL|BOND)|TREAS (BILLS?|NOTES?|BOND)/.test(n))
    return { assetClass: "treasury", isPublic: true, ticker: null };
  // Any debt instrument: a coupon %/maturity "Due <date>". Municipal/agency if it has issuer markers,
  // otherwise a corporate bond. Checked before the stock marker so "...COM ... DUE ..." isn't a stock.
  const isDebt = /\bDue \w/.test(name) || /\d(\.\d+)?\s*%/.test(name);
  if (isDebt) {
    const muni = /\bREV\b|OBLIG|\bB\/E\b|GENERAL OBLIG|\bGO\b|AUTH|SCH DIST|UNIV|CITY|CNTY|COUNTY|\bST\b/.test(n);
    return { assetClass: muni ? "muni_bond" : "corp_bond", isPublic: true, ticker: null };
  }
  if (/MONEY (MKT|MARKET)|CASH RESERVES?|\bRESERVE\b|MUTUAL FD|\bFUND\b|\bFD\b TR|TRUST FD/.test(n))
    return { assetClass: "fund", isPublic: true, ticker: null };
  // Common-stock markers.
  if (/\bCOM\b|COM CL|INC COM|CORP COM|\bCL [A-C]\b|COMMON (STOCK|SHARES)/.test(n))
    return { assetClass: "stock", isPublic: true, ticker: null };
  return { assetClass: "other", isPublic: false, ticker: null };
}

export function parse278eHoldings(text: string): Holding[] {
  const lines = text.split(/\r?\n/);
  const out: Holding[] = [];
  let nameBuf: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = line.match(DATA_LINE);
    if (m) {
      const [, , valueLabel, rest] = m;
      const assetName = nameBuf.join(" ").replace(/\s+/g, " ").trim();
      nameBuf = [];
      if (!assetName) continue; // mangled row with no recoverable asset name — skip, don't guess

      const value = parseDollars(valueLabel);
      if (value.min === null && value.max === null) continue; // unparseable value — skip

      const typeM = rest.match(INCOME_TYPE);
      const incomeBrackets = rest.match(new RegExp(VALUE_BRACKET, "g"));
      const incomeLabel = incomeBrackets ? incomeBrackets[0] : null;

      const cls = classify(assetName);
      // A real asset name is short; an over-long buffer is mangled boilerplate, so skip it rather
      // than ingest a junk row. DJT is special-cased (its row is a known multi-line blob).
      if (!cls.canonicalName && assetName.length > 100) continue;

      out.push({
        assetName: cls.canonicalName ?? assetName,
        ticker: cls.ticker,
        assetClass: cls.assetClass,
        isPublic: cls.isPublic,
        valueLabel: valueLabel.trim(),
        valueMin: value.min,
        valueMax: value.max,
        incomeType: typeM ? typeM[1] : null,
        incomeLabel,
      });
      continue;
    }

    if (NOISE.test(line)) {
      // Page furniture resets the name buffer so headers never leak into an asset name.
      nameBuf = [];
      continue;
    }
    nameBuf.push(line);
  }
  return out;
}
