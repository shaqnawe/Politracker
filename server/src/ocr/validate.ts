import {
  extractTicker,
  isArtifactTicker,
  parseAmount,
  parseOwner,
  parseTxType,
  toIsoDate,
} from "../util/parse.js";
import type { TradeInput } from "../util/types.js";
import type { ExtractedFiling, ExtractedTrade } from "./types.js";

/**
 * Validate + normalize an OCR extraction against the PTR domain rules (spec sections 2-4),
 * and decide what needs human review (spec section 5). Each extracted trade becomes a
 * normalized `TradeInput` plus a verdict: auto-ingestable only if every essential field is
 * present, valid, and clears the confidence gate. Nothing is fabricated — failures are flagged.
 */

/** Per-field confidence required to auto-ingest an essential field. Tunable from eval results. */
export const CONFIDENCE_THRESHOLD = 0.85;

// The 10 canonical PTR amount buckets, keyed as parse.ts would reduce them.
const CANONICAL_LABELS = [
  "$1,001 - $15,000",
  "$15,001 - $50,000",
  "$50,001 - $100,000",
  "$100,001 - $250,000",
  "$250,001 - $500,000",
  "$500,001 - $1,000,000",
  "$1,000,001 - $5,000,000",
  "$5,000,001 - $25,000,000",
  "$25,000,001 - $50,000,000",
  "Over $50,000,000",
];
const amountKey = (label: string): string => {
  const { min, max } = parseAmount(label);
  return `${min}|${max}`;
};
const CANONICAL_AMOUNTS = new Set(CANONICAL_LABELS.map(amountKey));

const TX_TYPES = new Set(["purchase", "sale", "sale_partial", "exchange"]);
const TICKER_RE = /^[A-Z][A-Z.\-]{0,6}$/;

export interface ValidatedTrade {
  /** Normalized, ingest-ready trade. */
  trade: TradeInput;
  /** Min confidence across essential fields (stored as ocr_confidence). */
  confidence: number;
  /** Whether this trade must go to review instead of the live table. */
  needsReview: boolean;
  /** Human-readable reasons it was flagged (rule failures + low-confidence fields). */
  reasons: string[];
}

export interface ValidatedFiling {
  trades: ValidatedTrade[];
  filingReasons: string[];
}

export interface ValidateOptions {
  /** Authoritative filed date (from the index) for date-sanity checks; falls back to OCR. */
  filingDate?: string | null;
  /** Expected filer (index member) for the cross-check; falls back to OCR-only. */
  expectedFiler?: string | null;
  threshold?: number;
}

const lastName = (name: string | null): string =>
  (name ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").trim().split(/\s+/).pop() ?? "";

function addYears(iso: string, years: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${y + years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Sanity-window reasons for one ISO date: it can't be in the future, can't post-date the filing,
 * and can't fall absurdly (>3y) before it. Applied to BOTH the transaction and notification dates —
 * a misread that pushes either past the filing or far into the past is caught here with no false
 * positives (these bounds are logical, not heuristic).
 */
function dateSanityReasons(kind: string, iso: string, filingDate: string | null): string[] {
  const out: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  if (iso > today) out.push(`${kind} is in the future`);
  if (filingDate && iso > filingDate) out.push(`${kind} after filing_date`);
  if (filingDate && iso < addYears(filingDate, -3)) out.push(`${kind} >3y before filing_date`);
  return out;
}

export function validateTrade(t: ExtractedTrade, filingDate: string | null, threshold: number): ValidatedTrade {
  const reasons: string[] = [];

  const owner = parseOwner(t.owner.value);
  const txType = parseTxType(t.transaction_type.value);
  const txDate = toIsoDate(t.transaction_date.value);
  const notifDate = toIsoDate(t.notification_date.value);
  const assetName = (t.asset_name.value ?? "").trim();
  const rawTicker = (t.ticker.value ?? extractTicker(assetName))?.toUpperCase().trim() || null;
  // Drop name/legal fragments OCR misreads as a ticker (e.g. "THE", "COM") — keep the trade via
  // asset_name. Format-odd-but-real symbols are left intact (still flag-only via Rule 8 below).
  const ticker = isArtifactTicker(rawTicker) ? null : rawTicker;
  const amount = t.amount_label.value ? parseAmount(t.amount_label.value) : { min: null, max: null };

  const trade: TradeInput = {
    transactionDate: txDate,
    owner,
    ticker,
    assetName,
    assetType: t.asset_type.value,
    txType,
    amountMin: amount.min,
    amountMax: amount.max,
    amountLabel: t.amount_label.value ?? "",
    comment: null,
  };

  if (t.row_unreadable) reasons.push("row marked unreadable");

  // Rule 1: transaction type
  if (!TX_TYPES.has(txType)) reasons.push(`transaction_type invalid/missing (${t.transaction_type.value ?? "null"})`);
  // Rule 7: at least one identifier
  if (!assetName && !ticker) reasons.push("no asset_name or ticker");
  // Rule 6: owner recognized
  if (owner === "unknown") reasons.push(`owner not recognized (${t.owner.value ?? "null"})`);
  // Rule 2: transaction date parses
  if (!txDate) reasons.push(`transaction_date invalid/missing (${t.transaction_date.value ?? "null"})`);
  // Rule 5: amount resolves to a canonical bucket
  if (!t.amount_label.value) reasons.push("amount_label missing");
  else if (!CANONICAL_AMOUNTS.has(amountKey(t.amount_label.value)))
    reasons.push(`amount_label not a canonical bucket (${t.amount_label.value})`);

  // Rule 3: notification-date ordering. Must parse, and not precede the transaction.
  if (t.notification_date.value && !notifDate) reasons.push("notification_date unparseable");
  if (txDate && notifDate && txDate > notifDate) reasons.push("transaction_date after notification_date");

  // Rule 4: date sanity (date hardening) — the SAME logical window applies to both dates. A wrong
  // month/year that pushes the transaction OR the notification date past the filing (or absurdly far
  // before it) is routed to review. NOTE: this catches GROSS misreads; a ±1-day in-window slip that
  // the model is confident about (observed on a typed fixture at 0.99) is not catchable by any rule
  // or threshold — that residual needs a second read (ensemble), tracked as a deferred option.
  if (txDate) reasons.push(...dateSanityReasons("transaction_date", txDate, filingDate));
  if (notifDate) reasons.push(...dateSanityReasons("notification_date", notifDate, filingDate));

  // Rule 8: ticker shape (flag only — new/odd symbols are real)
  if (ticker && !TICKER_RE.test(ticker)) reasons.push(`ticker has unexpected shape (${ticker})`);

  // Confidence gate over essential fields (asset OR ticker -> take the better of the two).
  const essential: Array<[string, number]> = [
    ["owner", t.owner.confidence],
    ["asset/ticker", Math.max(t.asset_name.confidence, t.ticker.confidence)],
    ["transaction_type", t.transaction_type.confidence],
    ["transaction_date", t.transaction_date.confidence],
    ["amount_label", t.amount_label.confidence],
  ];
  for (const [field, conf] of essential) {
    if (conf < threshold) reasons.push(`low confidence: ${field} (${conf.toFixed(2)})`);
  }
  const confidence = Math.min(...essential.map(([, c]) => c));

  return { trade, confidence, needsReview: t.row_unreadable || reasons.length > 0, reasons };
}

export function validateExtraction(x: ExtractedFiling, opts: ValidateOptions = {}): ValidatedFiling {
  const threshold = opts.threshold ?? CONFIDENCE_THRESHOLD;
  // Normalize to ISO so date comparisons against the (MM/DD/YYYY) source are correct.
  const filingDate = toIsoDate(opts.filingDate ?? x.filing.filing_date.value);
  const trades = x.transactions.map((t) => validateTrade(t, filingDate, threshold));

  const filingReasons: string[] = [];
  if (trades.length === 0) filingReasons.push("no transactions extracted (possible read failure)");
  if (opts.expectedFiler && x.filing.filer_name.value) {
    if (lastName(opts.expectedFiler) !== lastName(x.filing.filer_name.value)) {
      filingReasons.push(`filer name mismatch: OCR '${x.filing.filer_name.value}' vs index '${opts.expectedFiler}'`);
    }
  }
  return { trades, filingReasons };
}
