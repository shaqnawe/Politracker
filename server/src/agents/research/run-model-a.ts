import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupAgg } from "./aggregate.js";
import { runModelA, type FigureRow, type ModelAResult } from "./model-a.js";
import { createCsvProvider } from "./prices.js";
import type { HorizonLabel } from "./returns.js";

/**
 * Run Model A and write a data report (markdown + JSON) to server/data/reports/ (gitignored).
 * Methodology is the committed prose doc model-a-methodology.md — this is the numbers.
 *   npm run research:model-a            [-- --prices=<dir> --no-cache --dry]
 */

const HLABELS: HorizonLabel[] = ["1d", "1w", "1m", "3m"];
const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);
const pct0 = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);

function variantLine(label: string, g: GroupAgg): string {
  const m = (h: HorizonLabel) => pct(g.horizons[h].mean);
  return `| ${label} | ${g.nEvents} | ${m("1d")} | ${m("1w")} | ${m("1m")} | ${m("3m")} | ${pct0(g.horizons["1m"].hitRate)} | ${pct(g.horizons["1m"].weightedMean)} |`;
}

function figureTable(rows: FigureRow[], limit: number): string {
  const head = "| Figure | n | 1m mean | shrunk 1m | p(1m) | FDR | flag |\n|---|--:|--:|--:|--:|:--:|:--|";
  const body = rows.slice(0, limit).map((r) => {
    const g = r.result;
    return `| ${r.label} | ${g.nEvents} | ${pct(g.horizons["1m"].mean)} | ${pct(r.shrunk1m)} | ${r.p1m == null ? "—" : r.p1m.toFixed(3)} | ${r.rejectedFDR ? "✓" : ""} | ${g.lowConfidence ? "⚠ low-n" : ""} |`;
  });
  return [head, ...body].join("\n");
}

function figureSignedTable(rows: { result: GroupAgg; label: string }[], limit: number): string {
  const head = "| Figure | n | 1d | 1w | 1m | 3m | 1m right% | flag |\n|---|--:|--:|--:|--:|--:|--:|:--|";
  const body = rows.slice(0, limit).map(({ result: g, label }) => {
    const m = (h: HorizonLabel) => pct(g.horizons[h].mean);
    return `| ${label} | ${g.nEvents} | ${m("1d")} | ${m("1w")} | ${m("1m")} | ${m("3m")} | ${pct0(g.horizons["1m"].hitRate)} | ${g.lowConfidence ? "⚠ low-n" : ""} |`;
  });
  return [head, ...body].join("\n");
}

function groupTable(groups: GroupAgg[], limit: number): string {
  const head = "| Group | n | 1d | 1w | 1m | 3m | 1m up% | flag |\n|---|--:|--:|--:|--:|--:|--:|:--|";
  const rows = groups.slice(0, limit).map((g) => {
    const m = (h: HorizonLabel) => pct(g.horizons[h].mean);
    return `| ${g.group} | ${g.nEvents} | ${m("1d")} | ${m("1w")} | ${m("1m")} | ${m("3m")} | ${pct0(g.horizons["1m"].hitRate)} | ${g.lowConfidence ? "⚠ low-n" : ""} |`;
  });
  return [head, ...rows].join("\n");
}

function render(r: ModelAResult): string {
  const c = r.coverage;
  const L: string[] = [];
  L.push(`# Model A — Do Public Figures' Stock Statements Precede Price Moves? (data report)`);
  L.push(`\n_Generated ${r.generatedAt} · price source: \`${r.priceProvider}\` · benchmark: ${r.benchmark}_`);
  L.push(
    `\n> **Correlation analysis, not investment advice or a trading signal.** Forward **abnormal** ` +
      `returns vs the S&P 500 measured from the first close AFTER each statement (no look-ahead). ` +
      `UNSIGNED — a statement has no buy/sell direction, so "up%" = share that rose. Figures often ` +
      `mention names already moving, so read the run-up + baseline-adjusted rows. See \`model-a-methodology.md\`.`,
  );

  L.push(`\n## Coverage`);
  L.push(
    `\n- Mentions: **${c.mentions}** (by method: ${Object.entries(c.byMethod).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"})\n` +
      `- Scored (≥1 resolved horizon): **${c.scored}**\n` +
      `- Engine status: ${Object.entries(c.byStatus).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"}`,
  );

  if (c.scored === 0) {
    L.push(
      `\n## ⚠ No scored mentions yet\n\nEither no statements are ingested (\`npm run research:ingest-statements -- --file=...\`) ` +
        `or no mention resolved to a price. Ingest statements and load adjusted-close CSVs into ` +
        `\`server/data/prices/\` (incl. \`SPY.csv\`), then re-run. Methodology + refinements are in place.`,
    );
    return L.join("\n") + "\n";
  }

  const o = r.overall;
  L.push(`\n## Overall — headline + refinement variants`);
  L.push(
    "\n| Variant | n | 1d | 1w | 1m | 3m | 1m up% | 1m conf-wtd* |\n|---|--:|--:|--:|--:|--:|--:|--:|\n" +
      [
        variantLine("**all mentions (headline)**", o.all),
        variantLine("cashtag/explicit only (high-conf)", o.cashtagOnly),
        variantLine("market-model α/β · R5", o.marketModel),
        variantLine("validated tickers · R7", o.validated),
        variantLine("baseline-adjusted · R2 (− drift)", o.baselineAdjusted),
      ].join("\n"),
  );
  L.push(`\n\\* weighted by extraction confidence (cashtags > names).`);

  L.push(`\n### Uncertainty — overlap-aware bootstrap CI (R3)`);
  L.push(
    "\n| horizon | mean | 95% CI (cluster bootstrap) |\n|---|--:|--:|\n" +
      HLABELS.map((h) => `| ${h} | ${pct(r.bootstrap[h].mean)} | [${pct(r.bootstrap[h].lo)}, ${pct(r.bootstrap[h].hi)}] |`).join("\n"),
  );

  L.push(`\n### Reverse-causation check — pre-event run-up (R2)`);
  L.push(
    `\nMean 1-month abnormal **run-up** BEFORE these statements: **${pct(r.runup.meanRunup)}** (n=${r.runup.n}). ` +
      `Big positive run-up ⇒ figures tend to talk about stocks already outperforming, so any "post-statement" ` +
      `drift is partly the continuation of an existing move. The **baseline-adjusted** row nets out each ticker's drift.`,
  );

  const nc = r.newsCoincidence;
  L.push(`\n### News-coincidence control — already-in-news vs fresh (MA2)`);
  L.push(
    `\nOf ${r.coverage.scored} scored mentions, **${nc.covered}** had news coverage to assess ` +
      `(${nc.noCoverage} had none — can't tell). Within ${nc.windowDays}d before the statement: ` +
      `**${nc.priorNews}** were already in the news, **${nc.fresh}** were fresh.`,
  );
  if (nc.covered > 0) {
    L.push(
      "\n| subset | n | 1d | 1w | 1m | 3m | 1m up% | 1m conf-wtd* |\n|---|--:|--:|--:|--:|--:|--:|--:|\n" +
        [variantLine("already in news", nc.priorAgg), variantLine("fresh (no prior news)", nc.freshAgg)].join("\n"),
    );
    L.push(
      `\n_If "fresh" mentions move as much as "already in news" ones, reverse causation is weaker; if it ` +
        `concentrates in "already in news", it's stronger. News coverage is only as deep as the news agent ` +
        `has collected (currently sparse) — read accordingly._`,
    );
  } else {
    L.push(
      `\n_No mention's ticker had collected news in range, so MA2 can't assess yet. It becomes informative ` +
        `as the news agent (\`npm run job -- news\`) accumulates history._`,
    );
  }

  L.push(`\n### Corroborating signal — abnormal volume (MA8)`);
  L.push(
    r.abnVolume.n === 0
      ? `\n_No volume data loaded — MA8 can't assess. Provide a \`Volume\` column in the price CSVs (or use the Yahoo provider) to enable it._`
      : `\nMean abnormal trading volume on the statement day vs the trailing month: **${pct(r.abnVolume.mean)}** ` +
          `(n=${r.abnVolume.n}; 0% = normal, +100% = double). Elevated volume around a statement suggests the ` +
          `market was reacting/already active — a second axis beyond price.`,
  );

  L.push(`\n### Matched-date placebo (MA6)`);
  L.push(
    "\n| horizon | actual | placebo | excess | p | n |\n|---|--:|--:|--:|--:|--:|\n" +
      HLABELS.map((h) => {
        const c = r.placebo[h];
        return `| ${h} | ${pct(c.actual)} | ${pct(c.placebo)} | ${pct(c.excess)} | ${c.p == null ? "—" : c.p.toFixed(3)} | ${c.n} |`;
      }).join("\n"),
  );
  L.push(
    `\n_Placebo = the same tickers' abnormal return on random dates. **Excess** = actual − placebo; ` +
      `**p** = share of permutation draws where the placebo mean met/beat the actual. A small excess / ` +
      `large p means the post-statement move is no bigger than a random day in those names (reverse causation)._`,
  );

  const sm = r.sentiment;
  L.push(`\n## Sentiment-signed (MA1)`);
  L.push(
    `\nMention sentiment (deterministic lexicon): **${sm.bullish} bullish · ${sm.bearish} bearish · ` +
      `${sm.neutral} neutral**. The signed cut uses directional mentions only; **right%** = share where ` +
      `the price moved the figure's way (bullish→up, bearish→down). Sentiment is a heuristic keyword ` +
      `classifier — the UNSIGNED results above remain the headline.`,
  );
  if (sm.signedOverall.nEvents > 0) {
    L.push(
      "\n| cut | n | 1d | 1w | 1m | 3m | 1m right% | 1m conf-wtd* |\n|---|--:|--:|--:|--:|--:|--:|--:|\n" +
        variantLine("all directional mentions", sm.signedOverall),
    );
    L.push(`\n### By figure — directional accuracy (signed)`);
    L.push(`\n${figureSignedTable(sm.byFigure, 20)}`);
  } else {
    L.push(`\n_No directional (bullish/bearish) mentions among the scored set — nothing to sign._`);
  }

  L.push(`\n## By figure — with FDR + shrinkage (R4)`);
  L.push(`\n${figureTable(r.byFigure, 30)}`);
  L.push(`\n_p(1m) = two-sided p that mean 1m abnormal ≠ 0; **FDR ✓** survives Benjamini–Hochberg (q=0.1) across figures._`);

  L.push(`\n## Stratification & de-duplication (MA3–MA5)`);
  L.push(
    `\n**MA3 — de-dup:** collapsing repeat mentions of the same figure+ticker within ${r.dedup.windowDays}d ` +
      `removed **${r.dedup.collapsed}**; first-mention-only overall:`,
  );
  L.push(
    "\n| cut | n | 1d | 1w | 1m | 3m | 1m up% | 1m conf-wtd* |\n|---|--:|--:|--:|--:|--:|--:|--:|\n" +
      variantLine("first-mention-only", r.dedup.agg),
  );
  L.push(`\n**MA4 — by figure type:**\n\n${groupTable(r.byFigureKind, 8)}`);
  L.push(`\n**MA5 — by source/medium:**\n\n${groupTable(r.bySource, 8)}`);

  L.push(`\n## By extraction method (data-quality cut)`);
  L.push(`\n${groupTable(r.byMethod, 8)}`);
  L.push(`\n_cashtag/explicit are the most reliable mentions; name-matched are lower confidence._`);

  L.push(`\n## By ticker (most-mentioned first)`);
  L.push(`\n${groupTable(r.byTicker, 30)}`);

  L.push(`\n## Biggest moves after a mention by 1-month abnormal — _anecdotes, not evidence_`);
  const row = (t: ModelAResult["topMoves"][number]) => `| ${t.ticker} | ${t.figure} | ${t.date} | ${t.method} | ${pct(t.ab_1m)} |`;
  L.push("\n**Up most:**\n\n| ticker | figure | date | method | 1m |\n|---|---|---|:--|--:|\n" + r.topMoves.map(row).join("\n"));
  L.push("\n**Down most:**\n\n| ticker | figure | date | method | 1m |\n|---|---|---|:--|--:|\n" + r.bottomMoves.map(row).join("\n"));
  return L.join("\n") + "\n";
}

async function main() {
  const log = (m: string) => console.log(m);
  const argv = process.argv.slice(2);
  const pricesDir = argv.find((a) => a.startsWith("--prices="))?.split("=")[1];
  const result = await runModelA({
    log,
    provider: pricesDir ? createCsvProvider(resolve(process.cwd(), pricesDir)) : undefined,
    cache: argv.includes("--no-cache") ? false : undefined,
    dryRun: argv.includes("--dry"),
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outDir = resolve(__dirname, "../../../data/reports");
  mkdirSync(outDir, { recursive: true });
  const md = render(result);
  const stamp = result.generatedAt.replace(/[:.]/g, "-");
  writeFileSync(join(outDir, `model-a-${stamp}.md`), md);
  writeFileSync(join(outDir, "model-a-latest.md"), md);
  writeFileSync(join(outDir, "model-a-latest.json"), JSON.stringify(result, null, 2));

  const c = result.coverage;
  console.log(`\nModel A done. mentions=${c.mentions} scored=${c.scored}.`);
  if (c.scored === 0) console.log("No scored mentions — ingest statements + load prices, then re-run.");
  else {
    const m1 = result.overall.all.horizons["1m"];
    console.log(`Headline 1m: mean ${pct(m1.mean)} · up ${pct0(m1.hitRate)} · n=${m1.n} · run-up ${pct(result.runup.meanRunup)}`);
  }
  console.log(`Report: server/data/reports/model-a-latest.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
