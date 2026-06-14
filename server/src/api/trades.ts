import { Router } from "express";
import { db } from "../db.js";

export const tradesRouter = Router();

const recentStmt = db.prepare(`
  SELECT
    t.id, t.transaction_date AS transactionDate, t.owner, t.ticker,
    t.asset_name AS assetName, t.tx_type AS txType,
    t.amount_min AS amountMin, t.amount_max AS amountMax, t.amount_label AS amountLabel,
    m.id AS memberId, m.full_name AS memberName, m.chamber, m.state,
    f.filed_date AS filedDate, f.source_url AS sourceUrl
  FROM trades t
  JOIN members m ON m.id = t.member_id
  JOIN filings f ON f.id = t.filing_id
  WHERE (@ticker IS NULL OR t.ticker = @ticker)
    AND (@chamber IS NULL OR m.chamber = @chamber)
  ORDER BY t.transaction_date DESC NULLS LAST, t.id DESC
  LIMIT @limit OFFSET @offset
`);

// GET /api/trades?ticker=AAPL&chamber=senate&limit=50 — feed of recent trades.
tradesRouter.get("/", (req, res) => {
  const ticker = req.query.ticker ? String(req.query.ticker).toUpperCase() : null;
  const chamber = req.query.chamber ? String(req.query.chamber).toLowerCase() : null;
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  res.json({ trades: recentStmt.all({ ticker, chamber, limit, offset }) });
});
