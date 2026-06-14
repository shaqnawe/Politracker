import { Router } from "express";
import { db } from "../db.js";
import { getCompany } from "./db.js";

/**
 * Read API for the agents/context data. Mounted at /api so it adds:
 *   GET /api/companies/:ticker      — company profile: financials, review note, insiders, news
 *   GET /api/members/:id/context    — per traded ticker: financial flags + insider activity + news
 * Read-only; all numbers are disclosure-based/lagged and the AI note is labeled with its model so
 * the app can keep its caveat culture.
 */
export const agentsRouter = Router();

agentsRouter.get("/companies/:ticker", (req, res) => {
  const ticker = req.params.ticker.toUpperCase();
  const company = getCompany(ticker);
  if (!company) return res.status(404).json({ error: "unknown ticker" });

  const financials = db
    .prepare(
      `SELECT metric, fiscal_year AS fiscalYear, value, unit, period_end AS periodEnd
       FROM company_financials WHERE ticker = ? ORDER BY metric, fiscal_year DESC`,
    )
    .all(ticker);

  const noteRow = db
    .prepare(
      `SELECT body, flags_json AS flags, model, updated_at AS updatedAt
       FROM company_notes WHERE ticker = ? AND kind = 'financial_review'`,
    )
    .get(ticker) as { body: string; flags: string; model: string; updatedAt: string } | undefined;

  const insiderTrades = db
    .prepare(
      `SELECT insider_name AS insider, insider_title AS title, relationship, tx_type AS txType,
              tx_code AS code, acquired_disposed AS acquiredDisposed, tx_date AS date,
              shares, price, value, source_url AS sourceUrl
       FROM insider_trades WHERE ticker = ? ORDER BY tx_date DESC LIMIT 25`,
    )
    .all(ticker);

  const news = db
    .prepare(
      `SELECT title, url, source, published_at AS publishedAt, summary, event_type AS eventType, sentiment
       FROM news_items WHERE ticker = ? AND relevant = 1 ORDER BY published_at DESC LIMIT 12`,
    )
    .all(ticker);

  res.json({
    company: { ticker: company.ticker, cik: company.cik, name: company.name },
    financials,
    note: noteRow ? { ...noteRow, flags: JSON.parse(noteRow.flags ?? "[]") } : null,
    insiderTrades,
    news,
  });
});

agentsRouter.get("/members/:id/context", (req, res) => {
  const memberId = req.params.id;
  const member = db
    .prepare(`SELECT id, full_name AS fullName, chamber FROM members WHERE id = ?`)
    .get(memberId);
  if (!member) return res.status(404).json({ error: "unknown member" });

  const tickers = db
    .prepare(
      `SELECT UPPER(ticker) AS t, COUNT(*) AS c FROM trades
       WHERE member_id = ? AND ticker IS NOT NULL AND TRIM(ticker) != ''
       GROUP BY UPPER(ticker) ORDER BY c DESC LIMIT 12`,
    )
    .all(memberId) as { t: string; c: number }[];

  const noteStmt = db.prepare(
    `SELECT flags_json AS flags, body FROM company_notes WHERE ticker = ? AND kind = 'financial_review'`,
  );
  const insiderStmt = db.prepare(
    `SELECT COALESCE(SUM(tx_type='purchase'),0) AS buys, COALESCE(SUM(tx_type='sale'),0) AS sells,
            COUNT(*) AS total, MAX(tx_date) AS latest
     FROM insider_trades WHERE ticker = ?`,
  );
  const newsStmt = db.prepare(
    `SELECT title, url, summary, event_type AS eventType, sentiment, published_at AS publishedAt
     FROM news_items WHERE ticker = ? AND relevant = 1 ORDER BY published_at DESC LIMIT 2`,
  );

  const context = tickers.map(({ t, c }) => {
    const company = getCompany(t);
    const note = noteStmt.get(t) as { flags: string; body: string } | undefined;
    const insider = insiderStmt.get(t) as {
      buys: number;
      sells: number;
      total: number;
      latest: string | null;
    };
    return {
      ticker: t,
      tradeCount: c,
      name: company?.name ?? null,
      resolved: !!company?.cik,
      flags: note?.flags ? JSON.parse(note.flags) : [],
      financialNote: note?.body ?? null,
      insider,
      topNews: newsStmt.all(t),
    };
  });

  res.json({ member, context });
});
