import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupAgg } from "./aggregate.js";
import { runModelB, type MemberRow, type ModelBResult } from "./model-b.js";
import { createCsvProvider } from "./prices.js";
import type { HorizonLabel } from "./returns.js";

/**
 * Run Model B and write a data report (markdown + JSON) to server/data/reports/ (gitignored).
 * The *methodology* report is the committed prose doc model-b-methodology.md — this is the numbers.
 *   npm run research:model-b            [-- --prices=<dir> --no-cache --dry]
 */

const HLABELS: HorizonLabel[] = ["1d", "1w", "1m", "3m"];
const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(2)}%`);
const pct0 = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);

/** One row: a variant's mean at each horizon + 1m hit + 1m weighted mean. */
function variantLine(label: string, g: GroupAgg): string {
  const m = (h: HorizonLabel) => pct(g.horizons[h].mean);
  return `| ${label} | ${g.nEvents} | ${m("1d")} | ${m("1w")} | ${m("1m")} | ${m("3m")} | ${pct0(g.horizons["1m"].hitRate)} | ${pct(g.horizons["1m"].weightedMean)} |`;
}

function memberTable(rows: MemberRow[], limit: number): string {
  const head = "| Member | n | 1m mean | shrunk 1m | p(1m) | FDR | flag |\n|---|--:|--:|--:|--:|:--:|:--|";
  const body = rows.slice(0, limit).map((r) => {
    const g = r.result;
    return `| ${r.label} | ${g.nEvents} | ${pct(g.horizons["1m"].mean)} | ${pct(r.shrunk1m)} | ${r.p1m == null ? "—" : r.p1m.toFixed(3)} | ${r.rejectedFDR ? "✓" : ""} | ${g.lowConfidence ? "⚠ low-n" : ""} |`;
  });
  return [head, ...body].join("\n");
}

function groupTable(groups: GroupAgg[], limit: number): string {
  const head = "| Group | n | 1d | 1w | 1m | 3m | 1m hit | flag |\n|---|--:|--:|--:|--:|--:|--:|:--|";
  const rows = groups.slice(0, limit).map((g) => {
    const m = (h: HorizonLabel) => pct(g.horizons[h].mean);
    return `| ${g.group} | ${g.nEvents} | ${m("1d")} | ${m("1w")} | ${m("1m")} | ${m("3m")} | ${pct0(g.horizons["1m"].hitRate)} | ${g.lowConfidence ? "⚠ low-n" : ""} |`;
  });
  return [head, ...rows].join("\n");
}

function render(r: ModelBResult): string {
  const c = r.coverage;
  const L: string[] = [];
  L.push(`# Model B — Disclosed Congressional Trade Performance (data report)`);
  L.push(`\n_Generated ${r.generatedAt} · price source: \`${r.priceProvider}\` · benchmark: ${r.benchmark}_`);
  L.push(
    `\n> **Correlation analysis, not investment advice or a trading signal.** Forward **abnormal** ` +
      `returns vs the S&P 500 from each trade's transaction date, signed by direction (a sell that ` +
      `avoids a drop scores positive). Amounts are **ranges**, so weighted (\\*) figures are ` +
      `**estimates**. See \`model-b-methodology.md\`.`,
  );

  L.push(`\n## Coverage`);
  L.push(
    `\n- Eligible (needs_review excluded): **${c.eligible}**\n` +
      `- Excluded pre-pricing: ${c.excludedNoTicker} no/!ticker · ${c.excludedUnsupported} option/bond/fund · ${c.excludedExchange} exchange · ${c.excludedBadDate} bad date\n` +
      `- Priced attempts: **${c.attempted}** → scored: **${c.scored}** (${c.online} online · ${c.ocr} OCR)\n` +
      `- Engine status: ${Object.entries(c.byStatus).map(([k, v]) => `${k}=${v}`).join(" · ") || "—"}`,
  );

  if (c.scored === 0) {
    L.push(
      `\n## ⚠ No priced trades yet\n\nThe engine ran but no trade resolved to a price — the cache is ` +
        `empty for these tickers. Drop daily adjusted-close CSVs (incl. \`SPY.csv\`) into ` +
        `\`server/data/prices/\` (see its README) or set \`RESEARCH_PRICE_PROVIDER=yahoo\`, then re-run. ` +
        `Methodology + all refinements are in place; the tables fill in once prices exist.`,
    );
    return L.join("\n") + "\n";
  }

  const o = r.overall;
  L.push(`\n## Overall — headline + refinement variants`);
  L.push(
    "\n| Variant | n | 1d | 1w | 1m | 3m | 1m hit | 1m wtd* |\n|---|--:|--:|--:|--:|--:|--:|--:|\n" +
      [
        variantLine("**txn-date, β=1 (headline)**", o.txn),
        variantLine("online-only (drop OCR)", o.txnOnline),
        variantLine("disclosure-date · R1 (investable)", o.disclosure),
        variantLine("market-model α/β · R5", o.marketModel),
        variantLine("validated tickers · R7", o.validated),
        variantLine("baseline-adjusted · R2 (− drift)", o.baselineAdjusted),
        variantLine("buys only · R9", o.buys),
        variantLine("sells only · R9", o.sells),
      ].join("\n"),
  );
  L.push(`\n\\* weighted by amount-range midpoint — an estimate, not exact sizing.`);

  L.push(`\n### Uncertainty — overlap-aware bootstrap CI (R3) on the headline mean`);
  L.push(
    "\n| horizon | mean | 95% CI (cluster bootstrap) |\n|---|--:|--:|\n" +
      HLABELS.map((h) => `| ${h} | ${pct(r.bootstrap[h].mean)} | [${pct(r.bootstrap[h].lo)}, ${pct(r.bootstrap[h].hi)}] |`).join("\n"),
  );
  L.push(`\n_Clustered by (ticker, month) so overlapping windows don't masquerade as independent samples._`);

  L.push(`\n### Reverse-causation check — pre-event run-up (R2)`);
  L.push(
    `\nMean pre-trade 1-month abnormal **run-up** before these trades: **${pct(r.runup.meanRunup)}** ` +
      `(n=${r.runup.n}). Large positive run-up before buys ⇒ members tend to buy names already ` +
      `outperforming, so post-trade drift is partly momentum, not foresight. The **baseline-adjusted** ` +
      `row above nets out each ticker's own drift.`,
  );

  L.push(`\n## By member (most-active first) — with FDR + shrinkage (R4)`);
  L.push(`\n${memberTable(r.byMember, 30)}`);
  L.push(`\n_p(1m) = two-sided p that mean 1m abnormal ≠ 0; **FDR ✓** = survives Benjamini–Hochberg (q=0.1) across all members; shrunk = pulled toward the population mean. With ~150 members, expect false positives without FDR._`);

  L.push(`\n## By owner (R6)`);
  L.push(`\n${groupTable(r.byOwner.map((x) => x.result), 8)}`);
  L.push(`\n_Self-directed vs spouse/joint/dependent — the member files but may not have chosen the trade._`);

  L.push(`\n## By ticker (most-active first)`);
  L.push(`\n${groupTable(r.byTicker, 30)}`);

  L.push(`\n## Best / worst single trades by 1-month signed abnormal — _anecdotes, not evidence_`);
  const trow = (t: ModelBResult["bestTrades"][number]) =>
    `| ${t.ticker} | ${t.member} | ${t.direction} | ${t.date} | ${t.source} | ${pct(t.ab_1m)} |`;
  L.push("\n**Best:**\n\n| ticker | member | dir | date | src | 1m |\n|---|---|:--|---|:--|--:|\n" + r.bestTrades.map(trow).join("\n"));
  L.push("\n**Worst:**\n\n| ticker | member | dir | date | src | 1m |\n|---|---|:--|---|:--|--:|\n" + r.worstTrades.map(trow).join("\n"));

  L.push(`\n---\n_Committee-level analysis (R8) is deferred: the project has no committee data yet._`);
  return L.join("\n") + "\n";
}

async function main() {
  const log = (m: string) => console.log(m);
  const argv = process.argv.slice(2);
  const pricesDir = argv.find((a) => a.startsWith("--prices="))?.split("=")[1];
  const result = await runModelB({
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
  writeFileSync(join(outDir, `model-b-${stamp}.md`), md);
  writeFileSync(join(outDir, "model-b-latest.md"), md);
  writeFileSync(join(outDir, "model-b-latest.json"), JSON.stringify(result, null, 2));

  const c = result.coverage;
  console.log(`\nModel B done. eligible=${c.eligible} attempted=${c.attempted} scored=${c.scored} (online=${c.online} ocr=${c.ocr}).`);
  if (c.scored === 0) console.log("No priced trades — load CSVs into server/data/prices/ (see README) and re-run.");
  else {
    const m1 = result.overall.txn.horizons["1m"];
    console.log(`Headline 1m: mean ${pct(m1.mean)} · hit ${pct0(m1.hitRate)} · n=${m1.n} · run-up ${pct(result.runup.meanRunup)}`);
  }
  console.log(`Report: server/data/reports/model-b-latest.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
