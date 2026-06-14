import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memberSlug } from "./util/parse.js";
import type { FilingInput, MemberInput, ReviewQueueEntry, ScrapedFiling } from "./util/types.js";
import type { ExtractedFiling } from "./ocr/types.js";
import type { ValidatedFiling, ValidatedTrade } from "./ocr/validate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? resolve(__dirname, "../data/politracker.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS members (
    id          TEXT PRIMARY KEY,
    chamber     TEXT NOT NULL,
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    full_name   TEXT NOT NULL,
    state       TEXT,
    district    TEXT,
    party       TEXT,
    source_url  TEXT,
    first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS filings (
    id          TEXT PRIMARY KEY,
    member_id   TEXT NOT NULL REFERENCES members(id),
    chamber     TEXT NOT NULL,
    filed_date  TEXT,
    source_url  TEXT NOT NULL,
    scraped_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS trades (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    filing_id         TEXT NOT NULL REFERENCES filings(id),
    member_id         TEXT NOT NULL REFERENCES members(id),
    transaction_date  TEXT,
    owner             TEXT NOT NULL,
    ticker            TEXT,
    asset_name        TEXT NOT NULL,
    asset_type        TEXT,
    tx_type           TEXT NOT NULL,
    amount_min        INTEGER,
    amount_max        INTEGER,
    amount_label      TEXT NOT NULL,
    comment           TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_trades_member ON trades(member_id);
  CREATE INDEX IF NOT EXISTS idx_trades_filing ON trades(filing_id);
  CREATE INDEX IF NOT EXISTS idx_trades_ticker ON trades(ticker);
  CREATE INDEX IF NOT EXISTS idx_filings_member ON filings(member_id);

  -- OCR extractions that failed validation or the confidence gate land here for
  -- human review instead of the live trades table. One row per flagged trade.
  CREATE TABLE IF NOT EXISTS review_queue (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filing_id   TEXT NOT NULL REFERENCES filings(id),
    provider    TEXT,
    confidence  REAL,
    raw_json    TEXT NOT NULL,
    reasons     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved    INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_review_filing ON review_queue(filing_id);
  CREATE INDEX IF NOT EXISTS idx_review_resolved ON review_queue(resolved);

  -- Holdings from annual disclosures that are a SNAPSHOT, not dated transactions:
  -- the executive branch's OGE Form 278e (President/appointees). Kept separate from
  -- trades — one member can have holdings and zero PTR-style trades. Amounts are ranges.
  CREATE TABLE IF NOT EXISTS holdings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    member_id    TEXT NOT NULL REFERENCES members(id),
    report_type  TEXT NOT NULL,            -- e.g. 'annual_278e'
    report_year  INTEGER,
    asset_name   TEXT NOT NULL,
    ticker       TEXT,
    asset_class  TEXT NOT NULL,            -- stock|etf|fund|treasury|muni_bond|corp_bond|other
    value_min    INTEGER,
    value_max    INTEGER,
    value_label  TEXT NOT NULL,            -- verbatim OGE bracket
    income_type  TEXT,                     -- DIVIDEND|INTEREST|RENT|...
    income_label TEXT,
    source       TEXT NOT NULL DEFAULT 'oge',
    source_url   TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_holdings_member ON holdings(member_id);
`);

// --- Migration: add OCR provenance columns to existing tables (idempotent) ---
// scanned/paper filings are OCR'd into the same tables; these columns mark where
// a row came from and whether it still needs review. Online rows default to 'online'.
function columnExists(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function addColumn(table: string, column: string, ddl: string): void {
  if (!columnExists(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

addColumn("filings", "source", "source TEXT NOT NULL DEFAULT 'online'");
addColumn("filings", "ocr_provider", "ocr_provider TEXT");
addColumn("trades", "source", "source TEXT NOT NULL DEFAULT 'online'");
addColumn("trades", "ocr_confidence", "ocr_confidence REAL");
addColumn("trades", "needs_review", "needs_review INTEGER NOT NULL DEFAULT 0");
addColumn("trades", "ocr_provider", "ocr_provider TEXT");

const upsertMember = db.prepare(`
  INSERT INTO members (id, chamber, first_name, last_name, full_name, state, district, source_url)
  VALUES (@id, @chamber, @firstName, @lastName, @fullName, @state, @district, @sourceUrl)
  ON CONFLICT(id) DO UPDATE SET
    last_seen  = datetime('now'),
    state      = COALESCE(members.state, excluded.state),
    district   = COALESCE(members.district, excluded.district),
    source_url = COALESCE(excluded.source_url, members.source_url)
`);

const insertFiling = db.prepare(`
  INSERT INTO filings (id, member_id, chamber, filed_date, source_url)
  VALUES (@id, @memberId, @chamber, @filedDate, @sourceUrl)
`);

const filingExists = db.prepare(`SELECT 1 FROM filings WHERE id = ?`);
const filingProviderStmt = db.prepare(`SELECT ocr_provider AS p FROM filings WHERE id = ?`);

/** The OCR provider that produced a filing (e.g. 'openai', 'claude-cli'), or null if not OCR/absent.
 *  Lets a redo pass target only filings from a given provider. */
export function filingOcrProvider(id: string): string | null {
  const row = filingProviderStmt.get(id) as { p: string | null } | undefined;
  return row?.p ?? null;
}

const insertTrade = db.prepare(`
  INSERT INTO trades
    (filing_id, member_id, transaction_date, owner, ticker, asset_name, asset_type,
     tx_type, amount_min, amount_max, amount_label, comment)
  VALUES
    (@filingId, @memberId, @transactionDate, @owner, @ticker, @assetName, @assetType,
     @txType, @amountMin, @amountMax, @amountLabel, @comment)
`);

/** Has this filing already been ingested? Lets scrapers skip work. */
export function hasFiling(id: string): boolean {
  return !!filingExists.get(id);
}

const insertReview = db.prepare(`
  INSERT INTO review_queue (filing_id, provider, confidence, raw_json, reasons)
  VALUES (@filingId, @provider, @confidence, @rawJson, @reasons)
`);

/** Park a flagged OCR extraction for human review (raw extraction + reasons). */
export function enqueueReview(entry: ReviewQueueEntry): void {
  insertReview.run({
    filingId: entry.filingId,
    provider: entry.provider,
    confidence: entry.confidence,
    rawJson: JSON.stringify(entry.raw),
    reasons: JSON.stringify(entry.reasons),
  });
}

/**
 * Ingest one scraped filing (member + filing + trades) atomically.
 * Returns false if the filing was already present.
 */
/** Upsert a member from its input and return the stable member id. */
function resolveMember(member: MemberInput): string {
  const memberId = memberSlug(
    member.chamber,
    member.firstName,
    member.lastName,
    member.state,
    member.district,
  );
  const fullName = `${member.firstName} ${member.lastName}`.replace(/\s+/g, " ").trim();
  upsertMember.run({
    id: memberId,
    chamber: member.chamber,
    firstName: member.firstName,
    lastName: member.lastName,
    fullName,
    state: member.state,
    district: member.district,
    sourceUrl: member.sourceUrl,
  });
  return memberId;
}

export const ingestFiling = db.transaction((scraped: ScrapedFiling): boolean => {
  const { member, filing, trades } = scraped;
  if (filingExists.get(filing.id)) return false;

  const memberId = resolveMember(member);

  insertFiling.run({
    id: filing.id,
    memberId,
    chamber: filing.chamber,
    filedDate: filing.filedDate,
    sourceUrl: filing.sourceUrl,
  });

  for (const t of trades) {
    insertTrade.run({
      filingId: filing.id,
      memberId,
      transactionDate: t.transactionDate,
      owner: t.owner,
      ticker: t.ticker,
      assetName: t.assetName,
      assetType: t.assetType,
      txType: t.txType,
      amountMin: t.amountMin,
      amountMax: t.amountMax,
      amountLabel: t.amountLabel,
      comment: t.comment,
    });
  }
  return true;
});

// --- OCR ingest (STEP 6): provenance-tagged inserts for scanned/paper filings ---
const insertOcrFiling = db.prepare(`
  INSERT INTO filings (id, member_id, chamber, filed_date, source_url, source, ocr_provider)
  VALUES (@id, @memberId, @chamber, @filedDate, @sourceUrl, 'ocr', @provider)
`);

const insertOcrTrade = db.prepare(`
  INSERT INTO trades
    (filing_id, member_id, transaction_date, owner, ticker, asset_name, asset_type,
     tx_type, amount_min, amount_max, amount_label, comment,
     source, ocr_provider, ocr_confidence, needs_review)
  VALUES
    (@filingId, @memberId, @transactionDate, @owner, @ticker, @assetName, @assetType,
     @txType, @amountMin, @amountMax, @amountLabel, @comment,
     'ocr', @provider, @confidence, 0)
`);

const deleteTradesByFiling = db.prepare(`DELETE FROM trades WHERE filing_id = ?`);
const deleteReviewByFiling = db.prepare(`DELETE FROM review_queue WHERE filing_id = ?`);
const updateFilingOcr = db.prepare(`UPDATE filings SET ocr_provider = @provider, source = 'ocr' WHERE id = @id`);

export interface OcrIngestInput {
  member: MemberInput;
  filing: FilingInput; // id (DocID/UUID), chamber, filedDate, sourceUrl
  provider: string;
  extracted: ExtractedFiling; // raw model output, parked as review_queue.raw_json
  validated: ValidatedFiling; // verdicts; trades zip 1:1 with extracted.transactions
  /** Re-OCR: if the filing already exists, wipe its trades + review rows and re-route fresh
   *  (used to redo a filing with a better model). Without this, an existing filing is skipped. */
  replace?: boolean;
}

export interface OcrIngestResult {
  inserted: boolean;
  trades: number; // auto-ingested into `trades`
  review: number; // rows parked in `review_queue`
}

/**
 * Ingest one OCR'd filing atomically (STEP 6 routing). The filing row is ALWAYS written
 * (so it's cached and won't be re-OCR'd, and review_queue's FK holds). Trades that pass
 * validation + the confidence gate land in `trades` (source='ocr', needs_review=0);
 * everything else — flagged trades and any filing-level issues — goes to `review_queue`
 * with the raw extraction + reasons. Returns false if the filing was already ingested.
 */
export const ingestOcrFiling = db.transaction((input: OcrIngestInput): OcrIngestResult => {
  const exists = !!filingExists.get(input.filing.id);
  if (exists && !input.replace) return { inserted: false, trades: 0, review: 0 };

  const memberId = resolveMember(input.member);
  if (exists) {
    // Redo: clear the prior OCR rows for this filing, keep the filing row, mark the new provider.
    deleteTradesByFiling.run(input.filing.id);
    deleteReviewByFiling.run(input.filing.id);
    updateFilingOcr.run({ id: input.filing.id, provider: input.provider });
  } else {
    insertOcrFiling.run({
      id: input.filing.id,
      memberId,
      chamber: input.filing.chamber,
      filedDate: input.filing.filedDate,
      sourceUrl: input.filing.sourceUrl,
      provider: input.provider,
    });
  }

  let trades = 0;
  let review = 0;
  input.validated.trades.forEach((vt, i) => {
    if (!vt.needsReview) {
      insertOcrTrade.run({
        filingId: input.filing.id,
        memberId,
        transactionDate: vt.trade.transactionDate,
        owner: vt.trade.owner,
        ticker: vt.trade.ticker,
        assetName: vt.trade.assetName,
        assetType: vt.trade.assetType,
        txType: vt.trade.txType,
        amountMin: vt.trade.amountMin,
        amountMax: vt.trade.amountMax,
        amountLabel: vt.trade.amountLabel,
        comment: vt.trade.comment,
        provider: input.provider,
        confidence: vt.confidence,
      });
      trades++;
    } else {
      enqueueReview({
        filingId: input.filing.id,
        provider: input.provider,
        confidence: vt.confidence,
        raw: input.extracted.transactions[i] ?? vt.trade,
        reasons: vt.reasons,
      });
      review++;
    }
  });

  if (input.validated.filingReasons.length) {
    enqueueReview({
      filingId: input.filing.id,
      provider: input.provider,
      confidence: null,
      raw: { filing: input.extracted.filing, notes: input.extracted.extraction_notes },
      reasons: input.validated.filingReasons,
    });
    review++;
  }

  return { inserted: true, trades, review };
});

/**
 * Promote a previously-parked OCR row into `trades` and resolve its review_queue entry, atomically.
 * Used by the re-validation pass after a parser fix: rows whose stored raw extraction now clears
 * every rule + the confidence gate are moved to the live table (identical insert path to ingest).
 */
export const promoteReviewTrade = db.transaction(
  (input: { reviewId: number; memberId: string; filingId: string; provider: string | null; vt: ValidatedTrade }) => {
    insertOcrTrade.run({
      filingId: input.filingId,
      memberId: input.memberId,
      transactionDate: input.vt.trade.transactionDate,
      owner: input.vt.trade.owner,
      ticker: input.vt.trade.ticker,
      assetName: input.vt.trade.assetName,
      assetType: input.vt.trade.assetType,
      txType: input.vt.trade.txType,
      amountMin: input.vt.trade.amountMin,
      amountMax: input.vt.trade.amountMax,
      amountLabel: input.vt.trade.amountLabel,
      comment: input.vt.trade.comment,
      provider: input.provider,
      confidence: input.vt.confidence,
    });
    db.prepare(`UPDATE review_queue SET resolved = 1 WHERE id = ?`).run(input.reviewId);
  },
);

// --- Holdings (OGE 278e annual snapshot) ---
const upsertMemberWithId = db.prepare(`
  INSERT INTO members (id, chamber, first_name, last_name, full_name, state, district, source_url)
  VALUES (@id, @chamber, @firstName, @lastName, @fullName, @state, @district, @sourceUrl)
  ON CONFLICT(id) DO UPDATE SET
    last_seen  = datetime('now'),
    source_url = COALESCE(excluded.source_url, members.source_url)
`);

/** Insert/refresh a member under an explicit id (used for executive-branch filers like the President,
 *  whose identity isn't a Congress chamber+district slug). */
export function ensureMember(m: {
  id: string;
  chamber: string;
  firstName: string;
  lastName: string;
  state?: string | null;
  district?: string | null;
  sourceUrl?: string | null;
}): void {
  upsertMemberWithId.run({
    id: m.id,
    chamber: m.chamber,
    firstName: m.firstName,
    lastName: m.lastName,
    fullName: `${m.firstName} ${m.lastName}`.replace(/\s+/g, " ").trim(),
    state: m.state ?? null,
    district: m.district ?? null,
    sourceUrl: m.sourceUrl ?? null,
  });
}

export interface HoldingInput {
  assetName: string;
  ticker: string | null;
  assetClass: string;
  valueMin: number | null;
  valueMax: number | null;
  valueLabel: string;
  incomeType: string | null;
  incomeLabel: string | null;
}

const deleteHoldings = db.prepare(
  `DELETE FROM holdings WHERE member_id = ? AND report_type = ? AND IFNULL(report_year, -1) = IFNULL(?, -1)`,
);
const insertHolding = db.prepare(`
  INSERT INTO holdings
    (member_id, report_type, report_year, asset_name, ticker, asset_class,
     value_min, value_max, value_label, income_type, income_label, source, source_url)
  VALUES
    (@memberId, @reportType, @reportYear, @assetName, @ticker, @assetClass,
     @valueMin, @valueMax, @valueLabel, @incomeType, @incomeLabel, @source, @sourceUrl)
`);

/** Replace a member's holdings for one report (type+year) and insert the new set. Idempotent. */
export const ingestHoldings = db.transaction(
  (args: {
    memberId: string;
    reportType: string;
    reportYear: number | null;
    sourceUrl: string | null;
    source?: string;
    holdings: HoldingInput[];
  }): number => {
    deleteHoldings.run(args.memberId, args.reportType, args.reportYear ?? null);
    for (const h of args.holdings) {
      insertHolding.run({
        memberId: args.memberId,
        reportType: args.reportType,
        reportYear: args.reportYear,
        assetName: h.assetName,
        ticker: h.ticker,
        assetClass: h.assetClass,
        valueMin: h.valueMin,
        valueMax: h.valueMax,
        valueLabel: h.valueLabel,
        incomeType: h.incomeType,
        incomeLabel: h.incomeLabel,
        source: args.source ?? "oge",
        sourceUrl: args.sourceUrl,
      });
    }
    return args.holdings.length;
  },
);
