import { secHttp } from "../companies.js";
import { resolvedCompaniesByActivity, setCompanyFinancialsAt, upsertFinancial } from "../db.js";

/**
 * EDGAR XBRL financials collector (deterministic). Per resolved company, pulls SEC's companyfacts
 * and stores a curated set of ANNUAL metrics — revenue, net income, diluted EPS, total assets, and
 * stock buybacks — for the last few fiscal years. Companies tag the same metric under different
 * XBRL concepts, so each metric has a priority list; annual arrays repeat prior years as restated
 * comparatives, so we dedupe by fiscal year keeping the latest-filed value. Weekly cadence with a
 * freshness skip; upserts make it idempotent and restatement-aware.
 */
interface XbrlPoint {
  start?: string; // present for duration (income-statement) concepts
  end: string;
  val: number;
  fy: number;
  fp: string;
  form: string;
  filed: string;
  frame?: string;
}

interface Metric {
  metric: string;
  concepts: string[]; // first present wins
  unit: string; // preferred unit key
  /** true = balance-sheet point-in-time (Assets); false = income-statement full-year duration. */
  instant: boolean;
}

const METRICS: Metric[] = [
  {
    metric: "revenue",
    concepts: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"],
    unit: "USD",
    instant: false,
  },
  { metric: "net_income", concepts: ["NetIncomeLoss"], unit: "USD", instant: false },
  { metric: "eps_diluted", concepts: ["EarningsPerShareDiluted"], unit: "USD/shares", instant: false },
  { metric: "assets", concepts: ["Assets"], unit: "USD", instant: true },
  {
    metric: "buybacks",
    concepts: ["PaymentsForRepurchaseOfCommonStock", "PaymentsForRepurchaseOfEquity"],
    unit: "USD",
    instant: false,
  },
];

const dayDiff = (a: string, b: string): number => (Date.parse(b) - Date.parse(a)) / 86_400_000;

export interface FinancialsOptions {
  maxCompanies?: number;
  /** How many recent fiscal years to keep per metric. Default 5. */
  years?: number;
  /** Skip a company whose financials were pulled within this many days. Default 6 (weekly job). */
  freshnessDays?: number;
  log?: (msg: string) => void;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const daysSince = (iso: string | null): number =>
  iso ? (Date.now() - Date.parse(iso)) / 86_400_000 : Infinity;

/**
 * Annual datapoints for one concept, keyed by the period END (NOT the filing's `fy`, which repeats
 * across a 10-K's comparative years). Income-statement concepts keep only ~full-year durations;
 * balance-sheet (instant) concepts keep fiscal-year-end snapshots. Same period across restatements
 * → keep the latest-filed. Newest first, capped to `years`.
 */
function annualPoints(
  node: any,
  preferUnit: string,
  years: number,
  instant: boolean,
): { unit: string; points: XbrlPoint[] } {
  const units = node?.units ?? {};
  const unit = units[preferUnit] ? preferUnit : Object.keys(units)[0];
  let arr: XbrlPoint[] = (units[unit] ?? []).filter(
    (d: XbrlPoint) => d.form === "10-K" && d.val != null && d.end,
  );
  arr = instant
    ? arr.filter((d) => d.fp === "FY") // year-end balance-sheet snapshot
    : arr.filter((d) => d.start != null && dayDiff(d.start, d.end) >= 350 && dayDiff(d.start, d.end) <= 380);

  const byEnd = new Map<string, XbrlPoint>();
  for (const d of arr) {
    const cur = byEnd.get(d.end);
    if (!cur || (d.filed ?? "") > (cur.filed ?? "")) byEnd.set(d.end, d);
  }
  return { unit, points: [...byEnd.values()].sort((a, b) => b.end.localeCompare(a.end)).slice(0, years) };
}

export async function collectFinancials(
  opts: FinancialsOptions = {},
): Promise<{ companies: number; rows: number }> {
  const log = opts.log ?? (() => {});
  const years = opts.years ?? 5;
  const freshnessDays = opts.freshnessDays ?? 6;
  const companies = resolvedCompaniesByActivity(opts.maxCompanies);
  const http = secHttp();

  log(`Financials: pulling XBRL facts for up to ${companies.length} companies (last ${years} FYs)…`);
  let rows = 0;
  let scanned = 0;

  for (const co of companies) {
    if (!co.cik) continue;
    if (daysSince(co.last_financials_at) < freshnessDays) continue; // weekly freshness skip

    const url = `https://data.sec.gov/api/xbrl/companyfacts/CIK${co.cik}.json`;
    let facts: { facts?: { ["us-gaap"]?: Record<string, any> } };
    try {
      facts = await http.json(url);
    } catch (err) {
      log(`Financials: ${co.ticker} companyfacts failed: ${(err as Error).message}`);
      continue;
    }
    const gaap = facts.facts?.["us-gaap"];
    if (!gaap) {
      log(`Financials: ${co.ticker} has no us-gaap facts — skipped`);
      setCompanyFinancialsAt(co.ticker, todayIso());
      continue;
    }

    scanned++;
    let coRows = 0;
    for (const m of METRICS) {
      const concept = m.concepts.find((c) => gaap[c]);
      if (!concept) continue; // metric absent for this company — flagged by omission, not guessed
      const { unit, points } = annualPoints(gaap[concept], m.unit, years, m.instant);
      for (const p of points) {
        // Fiscal year derived from the period end (authoritative is period_end; this approximates
        // for off-calendar fiscal years, but stays stable as the row id).
        const fiscalYear = Number(p.end.slice(0, 4));
        upsertFinancial({
          id: `${co.ticker}-${m.metric}-${fiscalYear}`,
          ticker: co.ticker,
          cik: co.cik,
          metric: m.metric,
          concept,
          fiscalYear,
          fiscalPeriod: "FY",
          periodEnd: p.end,
          value: p.val,
          unit,
          form: p.form,
          filed: p.filed,
          sourceUrl: url,
        });
        coRows++;
        rows++;
      }
    }
    setCompanyFinancialsAt(co.ticker, todayIso());
    log(`Financials: ${co.ticker} — ${coRows} datapoints`);
  }

  log(`Financials: ${rows} datapoints across ${scanned} companies.`);
  return { companies: scanned, rows };
}
