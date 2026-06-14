/**
 * Shared OCR types. The *label* shape below is value-only ground truth; the
 * extraction adapters (STEP 4) return the same fields wrapped as
 * `{ value, confidence }`. Field vocabulary follows ptr-extraction-spec.md and
 * maps onto src/util/types.ts at ingest time — no parallel vocabulary downstream.
 */

/** Owner codes as printed on the PTR form (normalized to src/util Owner at ingest). */
export type OcrOwner = "self" | "spouse" | "dependent_child" | "joint";

/** Transaction type as printed (P/S/E, with partial sale called out). */
export type OcrTxType = "P" | "S" | "S_partial" | "E";

export type OcrAssetType =
  | "stock"
  | "option"
  | "bond"
  | "etf"
  | "mutual_fund"
  | "crypto"
  | "other";

/** One transaction row, ground-truth values only (no confidence). */
export interface ExpectedTrade {
  owner: OcrOwner | null;
  asset_name: string | null;
  ticker: string | null;
  asset_type: OcrAssetType | null;
  transaction_type: OcrTxType | null;
  transaction_date: string | null; // MM/DD/YYYY
  notification_date: string | null; // MM/DD/YYYY or null
  amount_label: string | null; // verbatim; must be a canonical PTR bucket
  row_unreadable: boolean;
}

/** A model-returned field: a value (or null if unreadable) plus 0-1 confidence. */
export interface Confident<T> {
  value: T | null;
  confidence: number;
}

/** One transaction as returned by an OCR provider (per-field confidence). */
export interface ExtractedTrade {
  owner: Confident<OcrOwner>;
  asset_name: Confident<string>;
  ticker: Confident<string>;
  asset_type: Confident<OcrAssetType>;
  transaction_type: Confident<OcrTxType>;
  transaction_date: Confident<string>;
  notification_date: Confident<string>;
  amount_label: Confident<string>;
  row_unreadable: boolean;
}

/** A whole filing as returned by an OCR provider. */
export interface ExtractedFiling {
  filing: {
    filer_name: Confident<string>;
    filing_date: Confident<string>;
    chamber: Confident<"house" | "senate">;
  };
  transactions: ExtractedTrade[];
  extraction_notes?: string;
}

/** Value-only view of a filing (labels, and the projection of an extraction for scoring). */
export interface FilingValues {
  filer_name: string | null;
  filing_date: string | null;
  chamber: "house" | "senate" | null;
}

/**
 * A pluggable OCR backend (Claude vision, OpenAI vision, ...). Implemented in STEP 4;
 * the eval harness (STEP 2) and runner (STEP 7) depend only on this interface.
 */
export interface OcrProvider {
  readonly name: string;
  extract(pageImages: Buffer[]): Promise<ExtractedFiling>;
}

/** A hand-labeled fixture: the expected extraction for one scanned PTR PDF. */
export interface ExpectedFiling {
  /** Fixture file this labels, e.g. "khanna-rohit-ca17-8220127.pdf". */
  fixture: string;
  filing: {
    filer_name: string | null;
    filing_date: string | null; // MM/DD/YYYY
    chamber: "house" | "senate" | null;
  };
  transactions: ExpectedTrade[];
  /** Set when the label covers only part of a long filing, e.g. "pages 1-2 of 28". */
  pages_labeled?: string;
  /** Free-text labeler notes (legibility, ambiguous cells, etc.). */
  notes?: string;
}
