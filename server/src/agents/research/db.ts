import { db } from "../../db.js";
import "../db.js"; // ensure the agents schema (news_items, companies, …) exists before we prepare against it

/**
 * Research/analysis schema — layered onto the same SQLite connection as the core app and the
 * agents layer (see ../../db.ts, ../db.ts). This file owns the tables the two analysis models and
 * the shared return engine depend on. Created idempotently at import, mirroring the rest of the db.
 *
 * `price_bars` is the project's ONE third-party price dependency, deliberately isolated here:
 * everything else comes from official disclosures, but a forward-return study needs market prices,
 * which no official/free U.S. gov source publishes. We cache every bar locally so we hit the source
 * once per symbol, stay polite, and keep the analysis reproducible (the data vintage is recorded).
 */
db.exec(`
  -- Daily adjusted-close bars per symbol, cached from the configured price source (default Yahoo).
  -- 'close' is the source's adjusted close. One row per (symbol, trading day). The benchmark
  -- (SPY) is stored here too and its set of dates defines the trading calendar for the engine.
  CREATE TABLE IF NOT EXISTS price_bars (
    symbol     TEXT NOT NULL,   -- normalized request symbol, upper-case (e.g. 'AAPL', 'SPY')
    date       TEXT NOT NULL,   -- ISO trading day (YYYY-MM-DD)
    close      REAL NOT NULL,   -- adjusted close
    volume     REAL,            -- daily share volume (optional; for MA8 abnormal-volume)
    source     TEXT NOT NULL,   -- 'csv' | 'yahoo'
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (symbol, date)
  );

  CREATE INDEX IF NOT EXISTS idx_price_bars_symbol ON price_bars(symbol, date);

  -- Per-symbol fetch coverage, so the cache knows what range it already holds and never re-hits the
  -- source for a symbol it has covered (or has already found unresolvable). status: 'ok' = bars
  -- present over [first_date,last_date]; 'unresolved' = source returned nothing (delisted/unknown
  -- symbol/non-US) — flagged, never guessed, same ethos as the OCR pipeline.
  CREATE TABLE IF NOT EXISTS price_symbols (
    symbol     TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    status     TEXT NOT NULL,   -- 'ok' | 'unresolved'
    first_date TEXT,
    last_date  TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Model B output: the forward SIGNED abnormal return (vs SPY) of each disclosed trade, from its
  -- transaction date, sign-adjusted by buy/sell. One row per trade. ab_* are signed abnormal
  -- returns (estimates — amounts are ranges); st_* are the per-horizon engine status. Recomputed
  -- in full on each run (cheap), so it always reflects the current price cache + engine.
  CREATE TABLE IF NOT EXISTS trade_returns (
    trade_id     INTEGER PRIMARY KEY REFERENCES trades(id),
    member_id    TEXT,
    ticker       TEXT,
    direction    TEXT,            -- buy | sell  (exchanges excluded)
    entry_date   TEXT,
    status       TEXT NOT NULL,   -- engine event status (ok | unresolved_ticker | ...)
    weight       REAL,            -- amount-range midpoint (estimate)
    source       TEXT,            -- 'online' | 'ocr' (provenance / trust)
    owner        TEXT,            -- self | spouse | joint | dependent (R6)
    validated    INTEGER,         -- 1 = ticker in the SEC-resolved company universe (R7)
    runup        REAL,            -- pre-event 1-month abnormal run-up (R2)
    ab_1d REAL, ab_1w REAL, ab_1m REAL, ab_3m REAL,   -- signed abnormal (txn-date, beta=1) headline
    st_1d TEXT,  st_1w TEXT,  st_1m TEXT,  st_3m TEXT,
    extra_json   TEXT,            -- disclosure-date / market-model / baseline-adjusted variants
    computed_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trade_returns_member ON trade_returns(member_id);
  CREATE INDEX IF NOT EXISTS idx_trade_returns_ticker ON trade_returns(ticker);
`);

// Migration: add the refinement columns to an existing trade_returns (idempotent).
{
  const cols = (db.prepare(`PRAGMA table_info(trade_returns)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE trade_returns ADD COLUMN ${ddl}`);
  };
  add("owner", "owner TEXT");
  add("validated", "validated INTEGER");
  add("runup", "runup REAL");
  add("extra_json", "extra_json TEXT");
}

export interface AnalysisTrade {
  id: number;
  member_id: string;
  ticker: string | null;
  asset_type: string | null;
  asset_name: string;
  tx_type: string;
  transaction_date: string | null;
  amount_min: number | null;
  amount_max: number | null;
  amount_label: string;
  owner: string;
  source: string;
  filed_date: string | null;
  full_name: string;
  chamber: string;
  state: string | null;
  party: string | null;
}

const analysisTradesStmt = db.prepare(`
  SELECT t.id, t.member_id, t.ticker, t.asset_type, t.asset_name, t.tx_type, t.transaction_date,
         t.amount_min, t.amount_max, t.amount_label, t.owner, t.source,
         f.filed_date,
         m.full_name, m.chamber, m.state, m.party
  FROM trades t
  JOIN members m ON m.id = t.member_id
  JOIN filings f ON f.id = t.filing_id
  WHERE t.needs_review = 0
  ORDER BY t.transaction_date
`);
/** All trades eligible for Model B (provisional `needs_review` rows excluded; OCR rows tagged). */
export function analysisTrades(): AnalysisTrade[] {
  return analysisTradesStmt.all() as AnalysisTrade[];
}

export interface TradeReturnRow {
  trade_id: number;
  member_id: string;
  ticker: string | null;
  direction: string | null;
  entry_date: string | null;
  status: string;
  weight: number | null;
  source: string;
  owner: string | null;
  validated: number | null;
  runup: number | null;
  ab_1d: number | null; ab_1w: number | null; ab_1m: number | null; ab_3m: number | null;
  st_1d: string; st_1w: string; st_1m: string; st_3m: string;
  extra_json: string | null;
}

const upsertTradeReturnStmt = db.prepare(`
  INSERT INTO trade_returns
    (trade_id, member_id, ticker, direction, entry_date, status, weight, source, owner, validated,
     runup, ab_1d, ab_1w, ab_1m, ab_3m, st_1d, st_1w, st_1m, st_3m, extra_json, computed_at)
  VALUES
    (@trade_id, @member_id, @ticker, @direction, @entry_date, @status, @weight, @source, @owner,
     @validated, @runup, @ab_1d, @ab_1w, @ab_1m, @ab_3m, @st_1d, @st_1w, @st_1m, @st_3m,
     @extra_json, datetime('now'))
  ON CONFLICT(trade_id) DO UPDATE SET
    member_id=excluded.member_id, ticker=excluded.ticker, direction=excluded.direction,
    entry_date=excluded.entry_date, status=excluded.status, weight=excluded.weight,
    source=excluded.source, owner=excluded.owner, validated=excluded.validated, runup=excluded.runup,
    ab_1d=excluded.ab_1d, ab_1w=excluded.ab_1w, ab_1m=excluded.ab_1m, ab_3m=excluded.ab_3m,
    st_1d=excluded.st_1d, st_1w=excluded.st_1w, st_1m=excluded.st_1m, st_3m=excluded.st_3m,
    extra_json=excluded.extra_json, computed_at=datetime('now')
`);
const upsertTradeReturnsTxn = db.transaction((rows: TradeReturnRow[]) => {
  for (const r of rows) upsertTradeReturnStmt.run(r);
});
export function saveTradeReturns(rows: TradeReturnRow[]): void {
  upsertTradeReturnsTxn(rows);
}

// --- Model A: public-figure statements -----------------------------------------------------------

db.exec(`
  -- The configurable list of public figures whose stock statements we track.
  CREATE TABLE IF NOT EXISTS figures (
    id         TEXT PRIMARY KEY,   -- slug
    name       TEXT NOT NULL,
    kind       TEXT,               -- politician | executive | pundit | official | ...
    handle     TEXT,               -- social handle, optional
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Dated public statements (speech transcripts, posts, press releases) — VERBATIM text as supplied.
  -- id is a stable hash of the source so re-ingesting the same statement is idempotent.
  CREATE TABLE IF NOT EXISTS statements (
    id         TEXT PRIMARY KEY,
    figure_id  TEXT NOT NULL REFERENCES figures(id),
    said_at    TEXT NOT NULL,      -- ISO date or datetime
    has_time   INTEGER NOT NULL DEFAULT 0,
    source     TEXT,               -- speech | x | press_release | interview | ...
    source_url TEXT,
    text       TEXT NOT NULL,      -- verbatim
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_statements_figure ON statements(figure_id, said_at);

  -- Tickers a statement mentions, extracted DETERMINISTICALLY (cashtag / explicit / company name).
  -- Never fabricated: a row exists only when a concrete symbol/name was found. said_at + has_time are
  -- denormalised so the return engine can be called straight off a mention.
  CREATE TABLE IF NOT EXISTS statement_mentions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    statement_id    TEXT NOT NULL REFERENCES statements(id),
    figure_id       TEXT NOT NULL,
    ticker          TEXT NOT NULL,
    company_name    TEXT,
    method          TEXT,          -- cashtag | explicit | name
    confidence      REAL,
    sentiment       TEXT,          -- bullish | bearish | neutral (MA1, deterministic at ingest)
    sentiment_score REAL,
    said_at         TEXT NOT NULL,
    has_time        INTEGER NOT NULL DEFAULT 0,
    UNIQUE(statement_id, ticker)
  );
  CREATE INDEX IF NOT EXISTS idx_mentions_figure ON statement_mentions(figure_id);
  CREATE INDEX IF NOT EXISTS idx_mentions_ticker ON statement_mentions(ticker);

  -- Model A output: forward abnormal return after each mention (unsigned). One row per mention.
  CREATE TABLE IF NOT EXISTS statement_returns (
    mention_id  INTEGER PRIMARY KEY REFERENCES statement_mentions(id),
    figure_id   TEXT,
    ticker      TEXT,
    entry_date  TEXT,
    status      TEXT NOT NULL,
    validated   INTEGER,
    runup       REAL,
    ab_1d REAL, ab_1w REAL, ab_1m REAL, ab_3m REAL,
    st_1d TEXT,  st_1w TEXT,  st_1m TEXT,  st_3m TEXT,
    extra_json  TEXT,
    computed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_statement_returns_figure ON statement_returns(figure_id);
  CREATE INDEX IF NOT EXISTS idx_statement_returns_ticker ON statement_returns(ticker);
`);

// Migration: add sentiment columns to an existing statement_mentions (idempotent).
{
  const cols = (db.prepare(`PRAGMA table_info(statement_mentions)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("sentiment")) db.exec(`ALTER TABLE statement_mentions ADD COLUMN sentiment TEXT`);
  if (!cols.includes("sentiment_score")) db.exec(`ALTER TABLE statement_mentions ADD COLUMN sentiment_score REAL`);
}

export interface FigureInput {
  id: string;
  name: string;
  kind?: string | null;
  handle?: string | null;
  notes?: string | null;
}
const upsertFigureStmt = db.prepare(`
  INSERT INTO figures (id, name, kind, handle, notes) VALUES (@id, @name, @kind, @handle, @notes)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, handle=excluded.handle, notes=excluded.notes
`);
export function upsertFigure(f: FigureInput): void {
  upsertFigureStmt.run({ id: f.id, name: f.name, kind: f.kind ?? null, handle: f.handle ?? null, notes: f.notes ?? null });
}

export interface StatementInput {
  id: string;
  figure_id: string;
  said_at: string;
  has_time: number;
  source: string | null;
  source_url: string | null;
  text: string;
}
const insertStatementStmt = db.prepare(`
  INSERT OR IGNORE INTO statements (id, figure_id, said_at, has_time, source, source_url, text)
  VALUES (@id, @figure_id, @said_at, @has_time, @source, @source_url, @text)
`);
/** Returns true if newly inserted (idempotent on id). */
export function insertStatement(s: StatementInput): boolean {
  return insertStatementStmt.run(s).changes > 0;
}

export interface MentionInput {
  statement_id: string;
  figure_id: string;
  ticker: string;
  company_name: string | null;
  method: string;
  confidence: number;
  sentiment: string | null;
  sentiment_score: number | null;
  said_at: string;
  has_time: number;
}
const insertMentionStmt = db.prepare(`
  INSERT OR IGNORE INTO statement_mentions
    (statement_id, figure_id, ticker, company_name, method, confidence, sentiment, sentiment_score, said_at, has_time)
  VALUES (@statement_id, @figure_id, @ticker, @company_name, @method, @confidence, @sentiment, @sentiment_score, @said_at, @has_time)
`);
export function insertMention(m: MentionInput): boolean {
  return insertMentionStmt.run(m).changes > 0;
}

export interface AnalysisMention {
  id: number;
  statement_id: string;
  figure_id: string;
  figure_name: string;
  figure_kind: string | null;
  ticker: string;
  company_name: string | null;
  method: string;
  confidence: number;
  sentiment: string | null;
  sentiment_score: number | null;
  source: string | null;
  said_at: string;
  has_time: number;
}
const analysisMentionsStmt = db.prepare(`
  SELECT sm.id, sm.statement_id, sm.figure_id, fg.name AS figure_name, fg.kind AS figure_kind,
         sm.ticker, sm.company_name, sm.method, sm.confidence, sm.sentiment, sm.sentiment_score,
         st.source AS source, sm.said_at, sm.has_time
  FROM statement_mentions sm
  JOIN figures fg ON fg.id = sm.figure_id
  JOIN statements st ON st.id = sm.statement_id
  ORDER BY sm.said_at
`);
export function analysisMentions(): AnalysisMention[] {
  return analysisMentionsStmt.all() as AnalysisMention[];
}

/**
 * Published dates (YYYY-MM-DD, ascending) of collected news per ticker — for Model A's
 * news-coincidence control (MA2). Sourced from the agents `news_items` table (free RSS). Coverage is
 * only as deep as the news agent has accumulated, so a ticker absent here means "we can't tell",
 * not "no news ever existed".
 */
const newsDatesStmt = db.prepare(
  `SELECT ticker, published_at FROM news_items WHERE ticker IS NOT NULL AND ticker <> '' AND published_at IS NOT NULL`,
);
export function newsDatesByTicker(): Map<string, string[]> {
  const rows = newsDatesStmt.all() as { ticker: string; published_at: string }[];
  const m = new Map<string, string[]>();
  for (const r of rows) {
    const t = r.ticker.toUpperCase();
    (m.get(t) ?? m.set(t, []).get(t)!).push(r.published_at.slice(0, 10));
  }
  for (const arr of m.values()) arr.sort();
  return m;
}

export interface StatementReturnRow {
  mention_id: number;
  figure_id: string;
  ticker: string;
  entry_date: string | null;
  status: string;
  validated: number | null;
  runup: number | null;
  ab_1d: number | null; ab_1w: number | null; ab_1m: number | null; ab_3m: number | null;
  st_1d: string; st_1w: string; st_1m: string; st_3m: string;
  extra_json: string | null;
}
const upsertStatementReturnStmt = db.prepare(`
  INSERT INTO statement_returns
    (mention_id, figure_id, ticker, entry_date, status, validated, runup,
     ab_1d, ab_1w, ab_1m, ab_3m, st_1d, st_1w, st_1m, st_3m, extra_json, computed_at)
  VALUES
    (@mention_id, @figure_id, @ticker, @entry_date, @status, @validated, @runup,
     @ab_1d, @ab_1w, @ab_1m, @ab_3m, @st_1d, @st_1w, @st_1m, @st_3m, @extra_json, datetime('now'))
  ON CONFLICT(mention_id) DO UPDATE SET
    figure_id=excluded.figure_id, ticker=excluded.ticker, entry_date=excluded.entry_date,
    status=excluded.status, validated=excluded.validated, runup=excluded.runup,
    ab_1d=excluded.ab_1d, ab_1w=excluded.ab_1w, ab_1m=excluded.ab_1m, ab_3m=excluded.ab_3m,
    st_1d=excluded.st_1d, st_1w=excluded.st_1w, st_1m=excluded.st_1m, st_3m=excluded.st_3m,
    extra_json=excluded.extra_json, computed_at=datetime('now')
`);
const saveStatementReturnsTxn = db.transaction((rows: StatementReturnRow[]) => {
  for (const r of rows) upsertStatementReturnStmt.run(r);
});
export function saveStatementReturns(rows: StatementReturnRow[]): void {
  saveStatementReturnsTxn(rows);
}


export interface PriceBar {
  date: string;
  close: number;
  volume?: number | null;
}

// Migration: add volume to an existing price_bars (idempotent).
{
  const cols = (db.prepare(`PRAGMA table_info(price_bars)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("volume")) db.exec(`ALTER TABLE price_bars ADD COLUMN volume REAL`);
}

/** All cached bars for a symbol, ascending by date. */
const barsStmt = db.prepare(
  `SELECT date, close, volume FROM price_bars WHERE symbol = ? ORDER BY date ASC`,
);
export function cachedBars(symbol: string): PriceBar[] {
  return barsStmt.all(symbol.toUpperCase()) as PriceBar[];
}

const upsertBarStmt = db.prepare(
  `INSERT INTO price_bars (symbol, date, close, volume, source) VALUES (@symbol, @date, @close, @volume, @source)
   ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close, volume = excluded.volume,
     source = excluded.source, fetched_at = datetime('now')`,
);
const upsertBarsTxn = db.transaction(
  (symbol: string, source: string, bars: PriceBar[]) => {
    for (const b of bars) {
      upsertBarStmt.run({ symbol, date: b.date, close: b.close, volume: b.volume ?? null, source });
    }
  },
);
/** Insert/refresh a batch of bars for one symbol in a single transaction. */
export function upsertBars(symbol: string, source: string, bars: PriceBar[]): void {
  upsertBarsTxn(symbol.toUpperCase(), source, bars);
}

export interface SymbolCoverage {
  symbol: string;
  source: string;
  status: "ok" | "unresolved";
  first_date: string | null;
  last_date: string | null;
}

const coverageStmt = db.prepare(`SELECT * FROM price_symbols WHERE symbol = ?`);
export function symbolCoverage(symbol: string): SymbolCoverage | undefined {
  return coverageStmt.get(symbol.toUpperCase()) as SymbolCoverage | undefined;
}

const setCoverageStmt = db.prepare(
  `INSERT INTO price_symbols (symbol, source, status, first_date, last_date, fetched_at)
   VALUES (@symbol, @source, @status, @first_date, @last_date, datetime('now'))
   ON CONFLICT(symbol) DO UPDATE SET source = excluded.source, status = excluded.status,
     first_date = excluded.first_date, last_date = excluded.last_date, fetched_at = datetime('now')`,
);
export function setSymbolCoverage(c: Omit<SymbolCoverage, "symbol"> & { symbol: string }): void {
  setCoverageStmt.run({
    symbol: c.symbol.toUpperCase(),
    source: c.source,
    status: c.status,
    first_date: c.first_date ?? null,
    last_date: c.last_date ?? null,
  });
}
