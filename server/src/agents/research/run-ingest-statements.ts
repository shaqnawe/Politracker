import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  insertMention,
  insertStatement,
  upsertFigure,
  type FigureInput,
} from "./db.js";
import { buildExtractor, extractMentions } from "./statements-extract.js";
import { sentimentForMention } from "./statements-sentiment.js";

/**
 * Ingest public-figure statements (Model A) from a JSON file you supply, then extract ticker
 * mentions DETERMINISTICALLY. No social/transcript scraper is built in (ToS/copyright); you provide
 * the data — same "supply-the-data" pattern as the price layer. Idempotent (statements keyed by a
 * content hash). Schema: see fixtures/statements-sample.json + server/data/prices/README analog.
 *
 *   npm run research:ingest-statements -- --file=path/to/statements.json
 *
 * Input: { "figures": [{id,name,kind?,handle?,notes?}], "statements": [{figure_id,said_at,source?,source_url?,text}] }
 */

interface RawStatement {
  figure_id: string;
  said_at: string;
  source?: string;
  source_url?: string;
  text: string;
}
interface InputFile {
  figures?: FigureInput[];
  statements?: RawStatement[];
}

const hasTime = (said_at: string): number => (/T\d{2}:/.test(said_at) ? 1 : 0);
const statementId = (s: RawStatement): string =>
  createHash("sha1").update(`${s.figure_id}|${s.said_at}|${s.source_url ?? s.text}`).digest("hex").slice(0, 16);

function main() {
  const file = process.argv.slice(2).find((a) => a.startsWith("--file="))?.split("=")[1];
  if (!file) throw new Error("usage: research:ingest-statements -- --file=path/to/statements.json");
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) throw new Error(`no such file: ${path}`);

  const input = JSON.parse(readFileSync(path, "utf8")) as InputFile;
  const knownFigures = new Set<string>();
  for (const f of input.figures ?? []) {
    upsertFigure(f);
    knownFigures.add(f.id);
  }

  const ex = buildExtractor();
  let newStatements = 0;
  let newMentions = 0;
  let withMentions = 0;
  let skippedNoFigure = 0;

  for (const s of input.statements ?? []) {
    if (!knownFigures.has(s.figure_id)) {
      // Tolerate statements whose figure wasn't declared — create a stub so nothing is dropped silently.
      upsertFigure({ id: s.figure_id, name: s.figure_id });
      knownFigures.add(s.figure_id);
      skippedNoFigure++;
    }
    if (!s.said_at || !s.text) continue;
    const id = statementId(s);
    const inserted = insertStatement({
      id,
      figure_id: s.figure_id,
      said_at: s.said_at,
      has_time: hasTime(s.said_at),
      source: s.source ?? null,
      source_url: s.source_url ?? null,
      text: s.text,
    });
    if (inserted) newStatements++;
    // Extract mentions every time (idempotent insert) so re-running picks up extractor improvements.
    const mentions = extractMentions(s.text, ex);
    if (mentions.length) withMentions++;
    for (const m of mentions) {
      const sent = sentimentForMention(s.text, m); // MA1: deterministic sentiment at ingest
      const added = insertMention({
        statement_id: id,
        figure_id: s.figure_id,
        ticker: m.ticker,
        company_name: m.company_name,
        method: m.method,
        confidence: m.confidence,
        sentiment: sent.label,
        sentiment_score: sent.score,
        said_at: s.said_at,
        has_time: hasTime(s.said_at),
      });
      if (added) newMentions++;
    }
  }

  console.log(
    `Ingested: ${input.figures?.length ?? 0} figure(s), ${newStatements} new statement(s) ` +
      `(${input.statements?.length ?? 0} seen), ${newMentions} new mention(s) across ${withMentions} statement(s).`,
  );
  if (skippedNoFigure) console.log(`  (${skippedNoFigure} statement(s) referenced an undeclared figure — stub created)`);
}

main();
