import { XMLParser } from "fast-xml-parser";

/**
 * Parse a SEC Form 4 ownership XML (`<ownershipDocument>`) into the fields we store. v1 keeps
 * NON-derivative transactions (open-market buys/sells and the like); derivative (options) rows are
 * skipped for now. Values are read as strings (parseTagValue:false) and coerced explicitly.
 */
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

export interface InsiderTxn {
  securityTitle: string | null;
  txCode: string | null;
  txDate: string | null; // already YYYY-MM-DD in the source
  shares: number | null;
  price: number | null;
  acquiredDisposed: string | null; // "A" acquired / "D" disposed
}

export interface Form4 {
  issuerCik: string | null;
  issuerName: string | null;
  symbol: string | null;
  ownerName: string | null;
  ownerTitle: string | null;
  relationship: string | null; // e.g. "director,officer,10% owner"
  transactions: InsiderTxn[];
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const isTrue = (v: unknown): boolean => v === "true" || v === "1" || v === 1 || v === true;

/** Map a Form 4 transaction code to our normalized type. P=open-market buy, S=sale; rest = other. */
export function txTypeFromCode(code: string | null): string | null {
  if (!code) return null;
  if (code === "P") return "purchase";
  if (code === "S") return "sale";
  return "other"; // A=grant, M=option exercise, G=gift, F=tax withholding, etc.
}

export function parseForm4(xml: string): Form4 | null {
  const root = parser.parse(xml)?.ownershipDocument;
  if (!root) return null;

  const issuer = root.issuer ?? {};
  const owner = Array.isArray(root.reportingOwner) ? root.reportingOwner[0] : root.reportingOwner;
  const rel = owner?.reportingOwnerRelationship ?? {};
  const roles: string[] = [];
  if (isTrue(rel.isDirector)) roles.push("director");
  if (isTrue(rel.isOfficer)) roles.push("officer");
  if (isTrue(rel.isTenPercentOwner)) roles.push("10% owner");
  if (isTrue(rel.isOther)) roles.push("other");

  const rawTxns = root.nonDerivativeTable?.nonDerivativeTransaction;
  const list = (Array.isArray(rawTxns) ? rawTxns : rawTxns ? [rawTxns] : []).filter(Boolean);
  const transactions: InsiderTxn[] = list.map((t: any) => {
    const amt = t.transactionAmounts ?? {};
    return {
      securityTitle: t.securityTitle?.value ?? null,
      txCode: t.transactionCoding?.transactionCode ?? null,
      txDate: t.transactionDate?.value ?? null,
      shares: num(amt.transactionShares?.value),
      price: num(amt.transactionPricePerShare?.value),
      acquiredDisposed: amt.transactionAcquiredDisposedCode?.value ?? null,
    };
  });

  return {
    issuerCik: issuer.issuerCik ?? null,
    issuerName: issuer.issuerName ?? null,
    symbol: issuer.issuerTradingSymbol ?? null,
    ownerName: owner?.reportingOwnerId?.rptOwnerName ?? null,
    ownerTitle: rel.officerTitle ?? null,
    relationship: roles.join(",") || null,
    transactions,
  };
}
