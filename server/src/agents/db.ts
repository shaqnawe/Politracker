import { db } from "../db.js";

/**
 * Agents/data-collection schema — layered onto the same SQLite connection as the core app
 * (see ../db.ts). Everything here keys off the existing `trades` data: the traded-ticker
 * universe bounds what we collect, and a code orchestrator records every job run. Tables are
 * created idempotently at import, mirroring the core db's pattern.
 */
db.exec(`
  -- Companies behind the tickers politicians trade. cik is null when ticker→CIK didn't resolve
  -- (flagged, never guessed — same ethos as the OCR pipeline).
  CREATE TABLE IF NOT EXISTS companies (
    ticker             TEXT PRIMARY KEY,
    cik                TEXT,
    name               TEXT,
    resolved_at        TEXT,
    last_form4_at      TEXT,
    last_financials_at TEXT
  );

  -- Job registry: one row per known job, holding its schedule + latest outcome (the
  -- orchestrator updates these). job_runs is the append-only history used for health/alerts.
  CREATE TABLE IF NOT EXISTS jobs (
    name        TEXT PRIMARY KEY,
    schedule    TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run    TEXT,
    last_status TEXT,
    last_error  TEXT
  );

  CREATE TABLE IF NOT EXISTS job_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job         TEXT NOT NULL,
    started     TEXT NOT NULL DEFAULT (datetime('now')),
    finished    TEXT,
    status      TEXT NOT NULL,
    rows_added  INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER,
    error       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, started);

  -- SEC Form 4 insider transactions for companies in the traded-ticker universe — "are insiders
  -- buying/selling the same stocks politicians are?". id = accession + row index (idempotent).
  -- v1 stores non-derivative transactions only.
  CREATE TABLE IF NOT EXISTS insider_trades (
    id                TEXT PRIMARY KEY,
    ticker            TEXT NOT NULL,
    cik               TEXT,
    accession         TEXT NOT NULL,
    insider_name      TEXT,
    insider_title     TEXT,
    relationship      TEXT,
    security_title    TEXT,
    tx_code           TEXT,
    tx_type           TEXT,
    acquired_disposed TEXT,
    tx_date           TEXT,
    shares            REAL,
    price             REAL,
    value             REAL,
    source_url        TEXT,
    scraped_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_insider_ticker ON insider_trades(ticker, tx_date);
  CREATE INDEX IF NOT EXISTS idx_insider_cik ON insider_trades(cik);

  -- Annual XBRL financials (SEC companyfacts) for the ticker universe: revenue, net income, EPS,
  -- assets, and stock buybacks. id = ticker-metric-fiscalYear (one row per metric per year);
  -- upserted so restated values refresh in place.
  CREATE TABLE IF NOT EXISTS company_financials (
    id            TEXT PRIMARY KEY,
    ticker        TEXT NOT NULL,
    cik           TEXT,
    metric        TEXT NOT NULL,
    concept       TEXT NOT NULL,
    fiscal_year   INTEGER,
    fiscal_period TEXT,
    period_end    TEXT,
    value         REAL,
    unit          TEXT,
    form          TEXT,
    filed         TEXT,
    source_url    TEXT,
    scraped_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_financials_ticker ON company_financials(ticker, metric, fiscal_year);

  -- News items per ticker (free Google News RSS). We store the link + a model-written summary only,
  -- never full article text (copyright/ToS). relevant: null = not yet processed by the research
  -- agent, 0/1 after the LLM filters + summarizes + tags it.
  CREATE TABLE IF NOT EXISTS news_items (
    id           TEXT PRIMARY KEY,
    ticker       TEXT,
    member_id    TEXT,
    source       TEXT,
    title        TEXT NOT NULL,
    url          TEXT,
    published_at TEXT,
    relevant     INTEGER,
    summary      TEXT,
    event_type   TEXT,
    sentiment    TEXT,
    model        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_news_ticker ON news_items(ticker, published_at);
  CREATE INDEX IF NOT EXISTS idx_news_relevant ON news_items(relevant);

  -- LLM-written notes about a company (kind='financial_review' in v1): a short grounded narrative
  -- + structured flags derived ONLY from the collected XBRL numbers. source_hash lets us skip
  -- regeneration when the underlying financials haven't changed (cost control).
  CREATE TABLE IF NOT EXISTS company_notes (
    id          TEXT PRIMARY KEY,
    ticker      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    body        TEXT,
    flags_json  TEXT,
    source_hash TEXT,
    model       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_notes_ticker ON company_notes(ticker, kind);
`);

// --- Ticker universe -------------------------------------------------------------------------

/** Distinct, uppercased tickers that appear in politician trades, most-traded first. */
export function tickerUniverse(): string[] {
  const rows = db
    .prepare(
      `SELECT UPPER(ticker) AS t, COUNT(*) AS c FROM trades
       WHERE ticker IS NOT NULL AND TRIM(ticker) != ''
       GROUP BY UPPER(ticker) ORDER BY c DESC`,
    )
    .all() as { t: string; c: number }[];
  return rows.map((r) => r.t);
}

// --- Companies -------------------------------------------------------------------------------

export interface CompanyInput {
  ticker: string;
  cik: string | null;
  name: string | null;
}

const upsertCompanyStmt = db.prepare(`
  INSERT INTO companies (ticker, cik, name, resolved_at)
  VALUES (@ticker, @cik, @name, datetime('now'))
  ON CONFLICT(ticker) DO UPDATE SET
    cik         = excluded.cik,
    name        = COALESCE(excluded.name, companies.name),
    resolved_at = datetime('now')
`);

/** Record a ticker→CIK resolution (cik null = unresolved, kept so we don't retry-thrash blindly). */
export function upsertCompany(c: CompanyInput): void {
  upsertCompanyStmt.run({ ticker: c.ticker.toUpperCase(), cik: c.cik, name: c.name });
}

export interface CompanyRow {
  ticker: string;
  cik: string | null;
  name: string | null;
  resolved_at: string | null;
  last_form4_at: string | null;
  last_financials_at: string | null;
}

export function getCompany(ticker: string): CompanyRow | undefined {
  return db.prepare(`SELECT * FROM companies WHERE ticker = ?`).get(ticker.toUpperCase()) as
    | CompanyRow
    | undefined;
}

/** Resolved companies (cik present) — the scope for EDGAR collectors in later phases. */
export function resolvedCompanies(): CompanyRow[] {
  return db.prepare(`SELECT * FROM companies WHERE cik IS NOT NULL ORDER BY ticker`).all() as CompanyRow[];
}

/** Resolved companies ordered by how often the ticker is traded — most-relevant first, capped. */
export function resolvedCompaniesByActivity(limit?: number): CompanyRow[] {
  const base = `
    SELECT c.* FROM companies c
    JOIN (
      SELECT UPPER(ticker) AS t, COUNT(*) AS c FROM trades
      WHERE ticker IS NOT NULL AND TRIM(ticker) != '' GROUP BY UPPER(ticker)
    ) f ON f.t = c.ticker
    WHERE c.cik IS NOT NULL
    ORDER BY f.c DESC`;
  if (limit && limit > 0) return db.prepare(`${base} LIMIT ?`).all(limit) as CompanyRow[];
  return db.prepare(base).all() as CompanyRow[];
}

const setForm4AtStmt = db.prepare(`UPDATE companies SET last_form4_at = @at WHERE ticker = @ticker`);
/** Record when we last scanned a company's Form 4 feed (incremental cutoff for next run). */
export function setCompanyForm4At(ticker: string, at: string): void {
  setForm4AtStmt.run({ ticker: ticker.toUpperCase(), at });
}

// --- Insider trades (SEC Form 4) -------------------------------------------------------------

export interface InsiderTradeInput {
  id: string;
  ticker: string;
  cik: string | null;
  accession: string;
  insiderName: string | null;
  insiderTitle: string | null;
  relationship: string | null;
  securityTitle: string | null;
  txCode: string | null;
  txType: string | null;
  acquiredDisposed: string | null;
  txDate: string | null;
  shares: number | null;
  price: number | null;
  value: number | null;
  sourceUrl: string | null;
}

const insertInsiderStmt = db.prepare(`
  INSERT OR IGNORE INTO insider_trades
    (id, ticker, cik, accession, insider_name, insider_title, relationship, security_title,
     tx_code, tx_type, acquired_disposed, tx_date, shares, price, value, source_url)
  VALUES
    (@id, @ticker, @cik, @accession, @insiderName, @insiderTitle, @relationship, @securityTitle,
     @txCode, @txType, @acquiredDisposed, @txDate, @shares, @price, @value, @sourceUrl)
`);

/** Insert one insider transaction; returns false if the id was already present (idempotent). */
export function insertInsiderTrade(row: InsiderTradeInput): boolean {
  return insertInsiderStmt.run(row).changes > 0;
}

// --- Company financials (SEC XBRL) -----------------------------------------------------------

const setFinancialsAtStmt = db.prepare(`UPDATE companies SET last_financials_at = @at WHERE ticker = @ticker`);
/** Record when we last pulled a company's XBRL facts (weekly-freshness skip on the next run). */
export function setCompanyFinancialsAt(ticker: string, at: string): void {
  setFinancialsAtStmt.run({ ticker: ticker.toUpperCase(), at });
}

export interface FinancialInput {
  id: string;
  ticker: string;
  cik: string | null;
  metric: string;
  concept: string;
  fiscalYear: number | null;
  fiscalPeriod: string | null;
  periodEnd: string | null;
  value: number | null;
  unit: string | null;
  form: string | null;
  filed: string | null;
  sourceUrl: string | null;
}

const upsertFinancialStmt = db.prepare(`
  INSERT INTO company_financials
    (id, ticker, cik, metric, concept, fiscal_year, fiscal_period, period_end, value, unit, form, filed, source_url)
  VALUES
    (@id, @ticker, @cik, @metric, @concept, @fiscalYear, @fiscalPeriod, @periodEnd, @value, @unit, @form, @filed, @sourceUrl)
  ON CONFLICT(id) DO UPDATE SET
    value = excluded.value, concept = excluded.concept, period_end = excluded.period_end,
    filed = excluded.filed, form = excluded.form, source_url = excluded.source_url,
    scraped_at = datetime('now')
`);

/** Upsert one financial datapoint (restated values refresh in place). */
export function upsertFinancial(row: FinancialInput): void {
  upsertFinancialStmt.run(row);
}

// --- News items (RSS + research agent) -------------------------------------------------------

export interface NewsItemInput {
  id: string;
  ticker: string | null;
  source: string | null;
  title: string;
  url: string | null;
  publishedAt: string | null;
}

const insertNewsStmt = db.prepare(`
  INSERT OR IGNORE INTO news_items (id, ticker, source, title, url, published_at)
  VALUES (@id, @ticker, @source, @title, @url, @publishedAt)
`);

/** Store a raw news item (unprocessed). Returns false if already present (idempotent). */
export function insertNewsItem(row: NewsItemInput): boolean {
  return insertNewsStmt.run(row).changes > 0;
}

export interface NewsRow {
  id: string;
  ticker: string | null;
  source: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
}

/** Raw news items not yet processed by the research agent (relevant IS NULL), newest first. */
export function unprocessedNews(limit: number): NewsRow[] {
  return db
    .prepare(
      `SELECT id, ticker, source, title, url, published_at FROM news_items
       WHERE relevant IS NULL ORDER BY ticker, published_at DESC LIMIT ?`,
    )
    .all(limit) as NewsRow[];
}

const updateNewsStmt = db.prepare(`
  UPDATE news_items
     SET relevant = @relevant, summary = @summary, event_type = @eventType,
         sentiment = @sentiment, model = @model, processed_at = datetime('now')
   WHERE id = @id
`);

export interface NewsClassificationUpdate {
  id: string;
  relevant: number; // 0/1
  summary: string | null;
  eventType: string | null;
  sentiment: string | null;
  model: string;
}

/** Write the research agent's verdict back onto a news item. */
export function updateNewsClassification(u: NewsClassificationUpdate): void {
  updateNewsStmt.run(u);
}

// --- Company notes (financial-review agent) --------------------------------------------------

export interface FinancialDatum {
  metric: string;
  fiscal_year: number;
  value: number;
  unit: string;
}

/** All stored financial datapoints for a ticker, newest year first (input to the review agent). */
export function financialsForTicker(ticker: string): FinancialDatum[] {
  return db
    .prepare(
      `SELECT metric, fiscal_year, value, unit FROM company_financials
       WHERE ticker = ? ORDER BY metric, fiscal_year DESC`,
    )
    .all(ticker.toUpperCase()) as FinancialDatum[];
}

/** Companies that have financials, ordered by trade activity — scope for the review agent. */
export function companiesWithFinancials(limit?: number): { ticker: string; name: string | null }[] {
  const base = `
    SELECT c.ticker, c.name FROM companies c
    JOIN (
      SELECT UPPER(ticker) AS t, COUNT(*) AS c FROM trades
      WHERE ticker IS NOT NULL AND TRIM(ticker) != '' GROUP BY UPPER(ticker)
    ) f ON f.t = c.ticker
    WHERE EXISTS (SELECT 1 FROM company_financials cf WHERE cf.ticker = c.ticker)
    ORDER BY f.c DESC`;
  const rows = limit && limit > 0 ? db.prepare(`${base} LIMIT ?`).all(limit) : db.prepare(base).all();
  return rows as { ticker: string; name: string | null }[];
}

export function getNote(ticker: string, kind: string): { source_hash: string | null } | undefined {
  return db
    .prepare(`SELECT source_hash FROM company_notes WHERE ticker = ? AND kind = ?`)
    .get(ticker.toUpperCase(), kind) as { source_hash: string | null } | undefined;
}

export interface NoteInput {
  ticker: string;
  kind: string;
  body: string | null;
  flagsJson: string | null;
  sourceHash: string;
  model: string;
}

const upsertNoteStmt = db.prepare(`
  INSERT INTO company_notes (id, ticker, kind, body, flags_json, source_hash, model, updated_at)
  VALUES (@id, @ticker, @kind, @body, @flagsJson, @sourceHash, @model, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    body = excluded.body, flags_json = excluded.flags_json, source_hash = excluded.source_hash,
    model = excluded.model, updated_at = datetime('now')
`);

/** Upsert a company note (id = ticker-kind). */
export function upsertNote(n: NoteInput): void {
  upsertNoteStmt.run({ id: `${n.ticker.toUpperCase()}-${n.kind}`, ...n, ticker: n.ticker.toUpperCase() });
}

// --- Jobs / orchestration --------------------------------------------------------------------

const upsertJobStmt = db.prepare(`
  INSERT INTO jobs (name, schedule, enabled) VALUES (@name, @schedule, 1)
  ON CONFLICT(name) DO UPDATE SET schedule = excluded.schedule
`);

/** Register (or update the schedule of) a job. Called when the registry is built. */
export function upsertJob(j: { name: string; schedule: string }): void {
  upsertJobStmt.run(j);
}

const insertRunStmt = db.prepare(
  `INSERT INTO job_runs (job, status) VALUES (?, 'running')`,
);
const markJobRunningStmt = db.prepare(
  `UPDATE jobs SET last_run = datetime('now'), last_status = 'running', last_error = NULL WHERE name = ?`,
);

/** Open a job_run row (status 'running') and return its id. */
export function recordJobStart(job: string): number {
  const info = insertRunStmt.run(job);
  markJobRunningStmt.run(job);
  return Number(info.lastInsertRowid);
}

const finishRunStmt = db.prepare(`
  UPDATE job_runs
     SET finished = datetime('now'), status = @status, rows_added = @rowsAdded,
         duration_ms = @durationMs, error = @error
   WHERE id = @id
`);
const finishJobStmt = db.prepare(
  `UPDATE jobs SET last_run = datetime('now'), last_status = @status, last_error = @error WHERE name = @job`,
);

/** Close out a job_run and reflect the outcome on the jobs row. */
export function recordJobFinish(
  id: number,
  job: string,
  r: { status: "ok" | "error"; rowsAdded: number; durationMs: number; error: string | null },
): void {
  finishRunStmt.run({ id, status: r.status, rowsAdded: r.rowsAdded, durationMs: r.durationMs, error: r.error });
  finishJobStmt.run({ job, status: r.status, error: r.error });
}

export interface JobHealth {
  name: string;
  schedule: string | null;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  ageHours: number | null;
}

/** Snapshot of every job's freshness + the most recent runs, for GET /api/health/jobs. */
export function jobsHealth(): { jobs: JobHealth[]; recentRuns: unknown[] } {
  const rows = db
    .prepare(
      `SELECT name, schedule, enabled, last_run AS lastRun, last_status AS lastStatus,
              last_error AS lastError,
              CAST((julianday('now') - julianday(last_run)) * 24 AS REAL) AS ageHours
       FROM jobs ORDER BY name`,
    )
    .all() as JobHealth[];
  const jobs = rows.map((r) => ({ ...r, enabled: !!r.enabled }));
  const recentRuns = db
    .prepare(
      `SELECT id, job, started, finished, status, rows_added AS rowsAdded, duration_ms AS durationMs, error
       FROM job_runs ORDER BY id DESC LIMIT 20`,
    )
    .all();
  return { jobs, recentRuns };
}
