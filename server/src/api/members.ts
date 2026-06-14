import { Router } from "express";
import { db } from "../db.js";

export const membersRouter = Router();

const listStmt = db.prepare(`
  SELECT
    m.id, m.chamber, m.full_name AS fullName, m.state, m.district, m.party,
    COUNT(DISTINCT t.id)                 AS tradeCount,
    MAX(t.transaction_date)              AS lastTradeDate,
    (SELECT COUNT(*) FROM review_queue rq JOIN filings f ON f.id = rq.filing_id
       WHERE f.member_id = m.id AND rq.resolved = 0) AS unverifiedCount,
    (SELECT COUNT(*) FROM holdings h WHERE h.member_id = m.id) AS holdingsCount
  FROM members m
  LEFT JOIN trades t ON t.member_id = m.id
  GROUP BY m.id
  HAVING tradeCount > 0 OR unverifiedCount > 0 OR holdingsCount > 0
  ORDER BY tradeCount DESC, holdingsCount DESC, m.last_name ASC
`);

// Holdings are an annual SNAPSHOT (OGE 278e), not dated trades — surfaced separately, clearly framed.
const holdingsStmt = db.prepare(`
  SELECT id, report_type AS reportType, report_year AS reportYear, asset_name AS assetName,
         ticker, asset_class AS assetClass, value_min AS valueMin, value_max AS valueMax,
         value_label AS valueLabel, income_type AS incomeType, income_label AS incomeLabel,
         source, source_url AS sourceUrl
  FROM holdings
  WHERE member_id = ?
  ORDER BY value_min DESC NULLS LAST, asset_name ASC
`);

const memberStmt = db.prepare(`
  SELECT id, chamber, first_name AS firstName, last_name AS lastName,
         full_name AS fullName, state, district, party, source_url AS sourceUrl
  FROM members WHERE id = ?
`);

const memberStatsStmt = db.prepare(`
  SELECT
    COUNT(*)                                          AS tradeCount,
    SUM(CASE WHEN tx_type = 'purchase' THEN 1 ELSE 0 END) AS buys,
    SUM(CASE WHEN tx_type LIKE 'sale%' THEN 1 ELSE 0 END) AS sells,
    MIN(transaction_date)                             AS firstTradeDate,
    MAX(transaction_date)                             AS lastTradeDate
  FROM trades WHERE member_id = ?
`);

const topTickersStmt = db.prepare(`
  SELECT ticker, COUNT(*) AS count
  FROM trades
  WHERE member_id = ? AND ticker IS NOT NULL
  GROUP BY ticker ORDER BY count DESC LIMIT 5
`);

const tradesStmt = db.prepare(`
  SELECT
    t.id, t.transaction_date AS transactionDate, t.owner, t.ticker,
    t.asset_name AS assetName, t.asset_type AS assetType, t.tx_type AS txType,
    t.amount_min AS amountMin, t.amount_max AS amountMax, t.amount_label AS amountLabel,
    t.comment, f.filed_date AS filedDate, f.source_url AS sourceUrl
  FROM trades t
  JOIN filings f ON f.id = t.filing_id
  WHERE t.member_id = ?
  ORDER BY t.transaction_date DESC NULLS LAST, t.id DESC
  LIMIT ? OFFSET ?
`);

// OCR rows that didn't clear the validation/confidence gate, parked in review_queue. Surfaced as
// PROVISIONAL trades (clearly flagged unverified). raw_json holds the raw extracted {value,confidence}
// fields; we read those and skip filing-level entries (which have no transaction fields).
const unverifiedStmt = db.prepare(`
  SELECT rq.id, rq.confidence, rq.raw_json AS rawJson, rq.reasons, rq.provider,
         f.filed_date AS filedDate, f.source_url AS sourceUrl
  FROM review_queue rq
  JOIN filings f ON f.id = rq.filing_id
  WHERE f.member_id = ? AND rq.resolved = 0
  ORDER BY rq.id DESC
  LIMIT ?
`);

const OCR_TX_TYPE: Record<string, string> = { P: "purchase", S: "sale", S_partial: "sale_partial", E: "exchange" };
const OCR_OWNER: Record<string, string> = { dependent_child: "dependent" };

interface ProvisionalTrade {
  id: number;
  transactionDate: string | null;
  owner: string | null;
  ticker: string | null;
  assetName: string | null;
  txType: string;
  amountLabel: string | null;
  confidence: number | null;
  reasons: string[];
  provider: string | null;
  filedDate: string | null;
  sourceUrl: string | null;
}

/** Map review_queue rows for a member into provisional (unverified) trades for display. */
function unverifiedTradesFor(memberId: string, limit: number): ProvisionalTrade[] {
  const rows = unverifiedStmt.all(memberId, limit) as {
    id: number;
    confidence: number | null;
    rawJson: string;
    reasons: string | null;
    provider: string | null;
    filedDate: string | null;
    sourceUrl: string | null;
  }[];
  const out: ProvisionalTrade[] = [];
  for (const r of rows) {
    let raw: any;
    try {
      raw = JSON.parse(r.rawJson);
    } catch {
      continue;
    }
    // Only per-trade entries (skip filing-level review notes, which have a `filing` key).
    if (!raw || raw.filing || (!raw.transaction_type && !raw.amount_label)) continue;
    const owner = raw.owner?.value ?? null;
    out.push({
      id: r.id,
      transactionDate: raw.transaction_date?.value ?? null,
      owner: owner ? (OCR_OWNER[owner] ?? owner) : null,
      ticker: raw.ticker?.value ?? null,
      assetName: raw.asset_name?.value ?? null,
      txType: OCR_TX_TYPE[raw.transaction_type?.value] ?? "other",
      amountLabel: raw.amount_label?.value ?? null,
      confidence: r.confidence,
      reasons: r.reasons ? JSON.parse(r.reasons) : [],
      provider: r.provider,
      filedDate: r.filedDate,
      sourceUrl: r.sourceUrl,
    });
  }
  return out;
}

// GET /api/members — every member who has disclosed at least one trade.
membersRouter.get("/", (_req, res) => {
  res.json({ members: listStmt.all() });
});

// GET /api/members/:id — profile + stats + recent trades.
membersRouter.get("/:id", (req, res) => {
  const member = memberStmt.get(req.params.id);
  if (!member) return res.status(404).json({ error: "member not found" });

  const limit = Math.min(Number(req.query.limit ?? 100), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  res.json({
    member,
    stats: memberStatsStmt.get(req.params.id),
    topTickers: topTickersStmt.all(req.params.id),
    trades: tradesStmt.all(req.params.id, limit, offset),
    unverifiedTrades: unverifiedTradesFor(req.params.id, 300),
    holdings: holdingsStmt.all(req.params.id),
  });
});
