export type Chamber = "house" | "senate";

export type Owner = "self" | "spouse" | "joint" | "dependent" | "unknown";

export type TxType = "purchase" | "sale" | "sale_partial" | "exchange" | "other";

/** A politician who has filed at least one disclosure. */
export interface MemberInput {
  chamber: Chamber;
  firstName: string;
  lastName: string;
  /** 2-letter state code, e.g. "GA". */
  state: string | null;
  /** House district number as a string, e.g. "12"; null for senators. */
  district: string | null;
  sourceUrl: string | null;
}

/** A single periodic transaction report (PTR) document. */
export interface FilingInput {
  /** Stable id from the source: House DocID or Senate report UUID. */
  id: string;
  chamber: Chamber;
  filedDate: string | null; // ISO date
  sourceUrl: string;
}

/** One transaction line within a filing. */
export interface TradeInput {
  transactionDate: string | null; // ISO date
  owner: Owner;
  ticker: string | null;
  assetName: string;
  assetType: string | null;
  txType: TxType;
  amountMin: number | null;
  amountMax: number | null;
  amountLabel: string;
  comment: string | null;
}

/** What a scraper hands back to the ingest layer. */
export interface ScrapedFiling {
  member: MemberInput;
  filing: FilingInput;
  trades: TradeInput[];
}

/**
 * A scanned filing the text scrapers skip (Senate paper, House DocID "8…"), surfaced for the
 * OCR pipeline. We yield metadata plus a lazy `download()` so the runner can skip filings it
 * already has BEFORE spending a PDF download or a vision-model call. No trades yet — those come
 * from OCR + validation downstream.
 */
export interface OcrCandidate {
  member: MemberInput;
  filing: FilingInput;
  /**
   * Fetch the scanned filing as RAW page images, in document order — House rasterizes its PDF,
   * Senate paper downloads its per-page GIFs. The runner then preprocesses (orient + enhance)
   * each page uniformly before handing them to the vision extractor.
   */
  loadPages(): Promise<Buffer[]>;
}

/** Where a filing/trade came from. OCR data is provisional until it clears review. */
export type TradeSource = "online" | "ocr";

/**
 * A flagged OCR extraction parked for human review — one row per trade that
 * failed validation or fell below the confidence gate. Keyed to its filing.
 */
export interface ReviewQueueEntry {
  filingId: string;
  /** Which OCR backend produced it, e.g. "claude" | "openai". */
  provider: string | null;
  /** Overall confidence for the flagged item, 0..1. */
  confidence: number | null;
  /** The raw extracted object (a single trade, or the whole filing) — stored as JSON. */
  raw: unknown;
  /** Why it was flagged: validation failures and/or low-confidence reasons. */
  reasons: string[];
}
