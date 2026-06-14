import { getCompany, unprocessedNews, updateNewsClassification, type NewsRow } from "../db.js";
import { classifyHeadlines, NEWS_MODEL } from "../llm.js";

/**
 * Research agent (news): turn raw, unprocessed news items into relevance + summary + tags via the
 * LLM. Cost controls: only items the agent hasn't seen (relevant IS NULL), grouped per company and
 * sent in batches (one call covers many headlines), capped per run. Re-running only touches new
 * items, so it's cheap and idempotent.
 */
export interface ResearchOptions {
  /** Max items to process this run. Default 60. */
  maxItems?: number;
  /** Headlines per LLM call. Default 15. */
  batchSize?: number;
  log?: (msg: string) => void;
}

function groupByTicker(rows: NewsRow[]): Map<string, NewsRow[]> {
  const m = new Map<string, NewsRow[]>();
  for (const r of rows) {
    const key = r.ticker ?? "";
    (m.get(key) ?? m.set(key, []).get(key)!).push(r);
  }
  return m;
}

export async function summarizeNews(
  opts: ResearchOptions = {},
): Promise<{ processed: number; relevant: number }> {
  const log = opts.log ?? (() => {});
  const maxItems = opts.maxItems ?? 60;
  const batchSize = opts.batchSize ?? 15;

  const pending = unprocessedNews(maxItems);
  if (pending.length === 0) {
    log("News research: nothing unprocessed.");
    return { processed: 0, relevant: 0 };
  }
  log(`News research: classifying ${pending.length} items with ${NEWS_MODEL}…`);

  let processed = 0;
  let relevant = 0;

  for (const [ticker, items] of groupByTicker(pending)) {
    const companyName = (ticker && getCompany(ticker)?.name) || ticker || "the company";
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      let results;
      try {
        results = await classifyHeadlines(
          companyName,
          batch.map((b) => ({ title: b.title, source: b.source })),
        );
      } catch (err) {
        log(`News research: ${ticker} batch failed: ${(err as Error).message}`);
        continue;
      }
      batch.forEach((row, j) => {
        const r = results[j];
        if (!r) return; // model returned fewer than asked — leave unprocessed for a retry
        const isRel = r.relevant ? 1 : 0;
        updateNewsClassification({
          id: row.id,
          relevant: isRel,
          summary: r.relevant ? (r.summary ?? null) : null,
          eventType: r.relevant ? (r.event_type ?? null) : null,
          sentiment: r.relevant ? (r.sentiment ?? null) : null,
          model: NEWS_MODEL,
        });
        processed++;
        relevant += isRel;
      });
    }
    log(`News research: ${ticker} — ${items.length} items reviewed`);
  }

  log(`News research: ${processed} processed, ${relevant} relevant.`);
  return { processed, relevant };
}
