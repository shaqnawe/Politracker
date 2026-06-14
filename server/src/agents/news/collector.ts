import { insertNewsItem, resolvedCompaniesByActivity } from "../db.js";
import { googleNewsRss, newsHttp } from "./rss.js";

/**
 * Deterministic news collector: for each in-scope company, pull its Google News RSS feed and store
 * raw items (dedupe by guid hash). No LLM here — relevance/summaries are the research agent's job
 * (a separate, paid step). Bounded by company count and per-ticker item cap to keep volume sane.
 */
export interface NewsOptions {
  maxCompanies?: number;
  /** Keep at most this many newest items per ticker per run. Default 20. */
  maxItemsPerTicker?: number;
  log?: (msg: string) => void;
}

/** Build a focused query: the company name (quoted) plus a stock cue, to bias toward market news. */
function queryFor(name: string | null, ticker: string): string {
  const base = name ? `"${name.replace(/[",]/g, " ").trim()}"` : ticker;
  return `${base} stock`;
}

export async function collectNews(opts: NewsOptions = {}): Promise<{ companies: number; rows: number }> {
  const log = opts.log ?? (() => {});
  const cap = opts.maxItemsPerTicker ?? 20;
  const companies = resolvedCompaniesByActivity(opts.maxCompanies);
  const http = newsHttp();

  log(`News: fetching RSS for ${companies.length} companies (≤${cap}/ticker)…`);
  let rows = 0;

  for (const co of companies) {
    let items;
    try {
      items = await googleNewsRss(http, queryFor(co.name, co.ticker));
    } catch (err) {
      log(`News: ${co.ticker} RSS failed: ${(err as Error).message}`);
      continue;
    }
    let added = 0;
    for (const it of items.slice(0, cap)) {
      if (
        insertNewsItem({
          id: it.id,
          ticker: co.ticker,
          source: it.source,
          title: it.title,
          url: it.url,
          publishedAt: it.publishedAt,
        })
      ) {
        added++;
        rows++;
      }
    }
    if (added) log(`News: ${co.ticker} — ${added} new items`);
  }

  log(`News: ${rows} new items across ${companies.length} companies.`);
  return { companies: companies.length, rows };
}
