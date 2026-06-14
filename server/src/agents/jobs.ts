import { resolveCompanies } from "./companies.js";
import { collectFinancials } from "./edgar/financials.js";
import { collectInsiderTrades } from "./edgar/insider.js";
import { collectNews } from "./news/collector.js";
import { summarizeNews } from "./news/research.js";
import { reviewCompanyFinancials } from "./research/review.js";
import { registerJob } from "./orchestrator.js";

/** Read a positive integer from an env var, or undefined if unset/invalid. */
function numEnv(name: string): number | undefined {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Like numEnv but allows 0 (e.g. a freshness window of 0 = force re-pull). */
function numEnv0(name: string): number | undefined {
  if (process.env[name] === undefined) return undefined;
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Register all agent jobs in one place. Imported by the CLI (run-job.ts) and, in Phase 7, by the
 * scheduler. Schedules are cron expressions per the architecture doc; they're informational until
 * the scheduler consumes them. Each job is deterministic and idempotent (LLM stays out of
 * collection — it's reserved for the research agent in later phases).
 */
export function registerAllJobs(): void {
  registerJob({
    name: "companies",
    schedule: "0 6 * * 1-5", // weekday mornings
    description: "Resolve the traded-ticker universe to SEC CIKs.",
    run: async ({ log }) => {
      const r = await resolveCompanies(log);
      return { rowsAdded: r.resolved };
    },
  });

  registerJob({
    name: "insider",
    schedule: "30 6 * * 1-5", // weekday mornings, after companies
    description: "Collect SEC Form 4 insider trades for the resolved-company universe.",
    run: async ({ log }) => {
      // Env overrides let this be smoke-tested small: INSIDER_MAX_COMPANIES, INSIDER_LOOKBACK_DAYS.
      const r = await collectInsiderTrades({
        log,
        maxCompanies: numEnv("INSIDER_MAX_COMPANIES"),
        lookbackDays: numEnv("INSIDER_LOOKBACK_DAYS"),
      });
      return { rowsAdded: r.rows };
    },
  });

  registerJob({
    name: "financials",
    schedule: "0 7 * * 1", // weekly (Monday); financials change slowly
    description: "Collect annual XBRL financials + buybacks for the resolved-company universe.",
    run: async ({ log }) => {
      const r = await collectFinancials({
        log,
        maxCompanies: numEnv("FINANCIALS_MAX_COMPANIES"),
        years: numEnv("FINANCIALS_YEARS"),
        freshnessDays: numEnv0("FINANCIALS_FRESH_DAYS"),
      });
      return { rowsAdded: r.rows };
    },
  });

  registerJob({
    name: "news",
    schedule: "0 */6 * * *", // a few times a day
    description: "Fetch raw company news from free RSS (deterministic; no LLM).",
    run: async ({ log }) => {
      const r = await collectNews({
        log,
        maxCompanies: numEnv("NEWS_MAX_COMPANIES"),
        maxItemsPerTicker: numEnv("NEWS_MAX_ITEMS_PER_TICKER"),
      });
      return { rowsAdded: r.rows };
    },
  });

  registerJob({
    name: "news-research",
    schedule: "30 */6 * * *", // shortly after news fetch
    description: "Research agent: LLM relevance + summary + tags for new news items.",
    run: async ({ log }) => {
      const r = await summarizeNews({ log, maxItems: numEnv("NEWS_RESEARCH_MAX_ITEMS") });
      return { rowsAdded: r.processed };
    },
  });

  registerJob({
    name: "financials-review",
    schedule: "30 7 * * 1", // weekly, after the financials pull
    description: "Research agent: LLM narrative + flags from collected XBRL financials.",
    run: async ({ log }) => {
      const r = await reviewCompanyFinancials({ log, maxCompanies: numEnv("REVIEW_MAX_COMPANIES") });
      return { rowsAdded: r.reviewed };
    },
  });
}
