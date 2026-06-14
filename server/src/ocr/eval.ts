import { parseAmount, toIsoDate } from "../util/parse.js";
import type { ExpectedFiling, ExpectedTrade, ExtractedFiling, ExtractedTrade, FilingValues } from "./types.js";
import { validateExtraction } from "./validate.js";

/**
 * Field-level scoring of an OCR extraction against a hand label. Both sides are
 * compared value-only, with field-appropriate normalization (dates parsed, amounts
 * reduced to their canonical bucket, names case/space-folded) so we measure real
 * disagreements, not formatting noise.
 */

export const TRADE_FIELDS = [
  "owner",
  "asset_name",
  "ticker",
  "asset_type",
  "transaction_type",
  "transaction_date",
  "notification_date",
  "amount_label",
] as const;
export type TradeField = (typeof TRADE_FIELDS)[number];

const FILING_FIELDS = ["filer_name", "filing_date", "chamber"] as const;
type FilingField = (typeof FILING_FIELDS)[number];

const upperAlnum = (v: string | null): string | null =>
  v == null ? null : v.toUpperCase().normalize("NFKD").replace(/[^A-Z0-9]+/g, " ").trim();

/** Reduce a verbatim amount label to a "min|max" bucket key (dash variants collapse). */
const amountKey = (v: string | null): string | null => {
  if (v == null) return null;
  const { min, max } = parseAmount(v);
  return `${min}|${max}`;
};

function tradeFieldEqual(field: TradeField, e: ExpectedTrade, a: ExpectedTrade): boolean {
  switch (field) {
    case "asset_name":
      return upperAlnum(e.asset_name) === upperAlnum(a.asset_name);
    case "ticker":
      return (e.ticker?.toUpperCase() ?? null) === (a.ticker?.toUpperCase() ?? null);
    case "transaction_date":
    case "notification_date":
      return toIsoDate(e[field]) === toIsoDate(a[field]);
    case "amount_label":
      return amountKey(e.amount_label) === amountKey(a.amount_label);
    default:
      return (e[field] as string | null) === (a[field] as string | null);
  }
}

const show = (v: string | null): string => (v == null ? "∅" : v);

/**
 * Greedily pair expected rows to extracted rows by normalized asset name, returning index
 * pairs (so callers can line up the raw extraction's per-field confidence and the validator's
 * verdict against the same rows the scorer matched).
 */
export function matchRows(exp: ExpectedTrade[], act: ExpectedTrade[]) {
  const used = new Set<number>();
  const pairs: Array<{ ei: number; ai: number }> = [];
  const missedIdx: number[] = [];
  for (let ei = 0; ei < exp.length; ei++) {
    const ek = upperAlnum(exp[ei].asset_name);
    let idx = ek == null ? -1 : act.findIndex((a, i) => !used.has(i) && upperAlnum(a.asset_name) === ek);
    if (idx < 0 && ek && ek.length >= 4) {
      const head = ek.slice(0, 8);
      idx = act.findIndex((a, i) => {
        if (used.has(i)) return false;
        const ak = upperAlnum(a.asset_name);
        return ak != null && (ak.startsWith(head) || ek.startsWith(ak.slice(0, 8)));
      });
    }
    if (idx >= 0) {
      used.add(idx);
      pairs.push({ ei, ai: idx });
    } else {
      missedIdx.push(ei);
    }
  }
  const spuriousIdx = act.map((_, i) => i).filter((i) => !used.has(i));
  return { pairs, missedIdx, spuriousIdx };
}

export interface FieldTally {
  correct: number;
  total: number;
}
export interface Miss {
  fixture: string;
  field: string;
  expected: string | null;
  actual: string | null;
}
export interface ProviderScore {
  provider: string;
  tradeFields: Record<TradeField, FieldTally>;
  filingFields: Record<FilingField, FieldTally>;
  rows: { matched: number; expected: number; spurious: number };
  misses: Miss[];
}

export function newScore(provider: string): ProviderScore {
  const tally = <K extends string>(keys: readonly K[]) =>
    Object.fromEntries(keys.map((k) => [k, { correct: 0, total: 0 }])) as Record<K, FieldTally>;
  return {
    provider,
    tradeFields: tally(TRADE_FIELDS),
    filingFields: tally(FILING_FIELDS),
    rows: { matched: 0, expected: 0, spurious: 0 },
    misses: [],
  };
}

/** Project a provider extraction to value-only for scoring. */
export function projectExtracted(x: ExtractedFiling): {
  filing: FilingValues;
  transactions: ExpectedTrade[];
} {
  return {
    filing: {
      filer_name: x.filing.filer_name.value,
      filing_date: x.filing.filing_date.value,
      chamber: x.filing.chamber.value,
    },
    transactions: x.transactions.map((t) => ({
      owner: t.owner.value,
      asset_name: t.asset_name.value,
      ticker: t.ticker.value,
      asset_type: t.asset_type.value,
      transaction_type: t.transaction_type.value,
      transaction_date: t.transaction_date.value,
      notification_date: t.notification_date.value,
      amount_label: t.amount_label.value,
      row_unreadable: t.row_unreadable,
    })),
  };
}

export function scoreFixture(
  score: ProviderScore,
  expected: ExpectedFiling,
  actual: { filing: FilingValues; transactions: ExpectedTrade[] },
): void {
  for (const f of FILING_FIELDS) {
    const ev = expected.filing[f];
    const av = actual.filing[f];
    const eq =
      f === "filing_date"
        ? toIsoDate(ev) === toIsoDate(av)
        : f === "filer_name"
          ? upperAlnum(ev) === upperAlnum(av)
          : ev === av;
    score.filingFields[f].total++;
    if (eq) score.filingFields[f].correct++;
    else score.misses.push({ fixture: expected.fixture, field: `filing.${f}`, expected: ev, actual: av });
  }

  const { pairs, missedIdx, spuriousIdx } = matchRows(expected.transactions, actual.transactions);
  score.rows.expected += expected.transactions.length;
  score.rows.matched += pairs.length;
  score.rows.spurious += spuriousIdx.length;

  for (const f of TRADE_FIELDS) {
    for (const { ei, ai } of pairs) {
      const e = expected.transactions[ei];
      const a = actual.transactions[ai];
      score.tradeFields[f].total++;
      if (tradeFieldEqual(f, e, a)) score.tradeFields[f].correct++;
      else
        score.misses.push({
          fixture: expected.fixture,
          field: f,
          expected: show(e[f] as string | null),
          actual: show(a[f] as string | null),
        });
    }
    // A row the model failed to find counts against every field (recall penalty).
    for (let i = 0; i < missedIdx.length; i++) score.tradeFields[f].total++;
  }
  for (const ei of missedIdx)
    score.misses.push({
      fixture: expected.fixture,
      field: "(missed row)",
      expected: expected.transactions[ei].asset_name,
      actual: null,
    });
}

/** A partial label (e.g. "2 of 22", "2, 8, 9, 12 of 22") → the page numbers it covers. */
export function pagesFromLabel(label: ExpectedFiling): number[] | undefined {
  if (!label.pages_labeled) return undefined;
  const nums = label.pages_labeled.split(/of/i)[0].match(/\d+/g)?.map(Number) ?? [];
  return nums.length ? nums : undefined;
}

const pct = (t: FieldTally): string =>
  t.total === 0 ? "  n/a" : `${((100 * t.correct) / t.total).toFixed(1)}%`.padStart(6);

export function formatReport(score: ProviderScore, maxMisses = 15): string {
  const lines: string[] = [];
  lines.push(`\n=== ${score.provider} ===`);
  const recall =
    score.rows.expected === 0 ? "n/a" : `${((100 * score.rows.matched) / score.rows.expected).toFixed(1)}%`;
  lines.push(
    `rows: matched ${score.rows.matched}/${score.rows.expected} (recall ${recall}), spurious ${score.rows.spurious}`,
  );
  lines.push("\nfiling fields:");
  for (const f of FILING_FIELDS) {
    const t = score.filingFields[f];
    lines.push(`  ${f.padEnd(18)} ${pct(t)}   ${t.correct}/${t.total}`);
  }
  lines.push("\ntransaction fields:");
  for (const f of TRADE_FIELDS) {
    const t = score.tradeFields[f];
    lines.push(`  ${f.padEnd(18)} ${pct(t)}   ${t.correct}/${t.total}`);
  }
  if (score.misses.length) {
    lines.push(`\nmisses (${score.misses.length}, showing up to ${maxMisses}):`);
    for (const m of score.misses.slice(0, maxMisses)) {
      lines.push(`  ${m.fixture}  ${m.field}: expected ${show(m.expected)} -> got ${show(m.actual)}`);
    }
  }
  return lines.join("\n");
}

/**
 * Confidence-vs-correctness analysis: does the model's confidence (and therefore the validation
 * gate) actually catch the rows it gets wrong, or does it auto-ingest them confidently? This is
 * the safety question the accuracy report can't answer — a wrong field with LOW confidence is
 * caught (routed to review); a wrong field with HIGH confidence is a silent error.
 *
 * Essential fields mirror the gate in validate.ts: owner, asset/ticker (the better of the two),
 * transaction_type, transaction_date, amount_label.
 */
export const ESSENTIAL_FIELDS = [
  "owner",
  "asset/ticker",
  "transaction_type",
  "transaction_date",
  "amount_label",
] as const;
export type EssentialField = (typeof ESSENTIAL_FIELDS)[number];

/** A 2×2 of confidence (≥ vs < threshold) against correctness, per essential field. */
export interface ConfBucket {
  hiCorrect: number; // confident & right  → auto-ingest, correct (the goal)
  hiWrong: number; //   confident & wrong  → SILENT ERROR (the danger)
  loCorrect: number; // unsure & right     → sent to review unnecessarily (false alarm)
  loWrong: number; //   unsure & wrong     → caught by the gate (working as intended)
}

/** Row-level outcome of the real validation gate, cross-referenced with ground-truth correctness. */
export interface GateSummary {
  matched: number; // model rows paired to a labeled row
  autoCorrect: number; // not flagged & every essential field correct
  autoWrong: number; //  not flagged & ≥1 essential field wrong  → SILENT ERROR
  reviewWrong: number; // flagged & ≥1 essential field wrong      → correctly caught
  reviewCorrect: number; // flagged & all essential correct       → false alarm
  spurious: number; // model rows with no labeled match
  spuriousAuto: number; // …of those, NOT flagged (would auto-ingest without ground truth)
  missed: number; // labeled rows the model never produced
}

export interface ConfidenceReport {
  provider: string;
  threshold: number;
  fields: Record<EssentialField, ConfBucket>;
  gate: GateSummary;
}

function essentialConfidence(t: ExtractedTrade, field: EssentialField): number {
  switch (field) {
    case "owner":
      return t.owner.confidence;
    case "asset/ticker":
      return Math.max(t.asset_name.confidence, t.ticker.confidence);
    case "transaction_type":
      return t.transaction_type.confidence;
    case "transaction_date":
      return t.transaction_date.confidence;
    case "amount_label":
      return t.amount_label.confidence;
  }
}

function essentialCorrect(field: EssentialField, e: ExpectedTrade, a: ExpectedTrade): boolean {
  if (field === "asset/ticker")
    return tradeFieldEqual("asset_name", e, a) || tradeFieldEqual("ticker", e, a);
  return tradeFieldEqual(field, e, a);
}

export function newConfidenceReport(provider: string, threshold: number): ConfidenceReport {
  const fields = Object.fromEntries(
    ESSENTIAL_FIELDS.map((f) => [f, { hiCorrect: 0, hiWrong: 0, loCorrect: 0, loWrong: 0 }]),
  ) as Record<EssentialField, ConfBucket>;
  return {
    provider,
    threshold,
    fields,
    gate: {
      matched: 0,
      autoCorrect: 0,
      autoWrong: 0,
      reviewWrong: 0,
      reviewCorrect: 0,
      spurious: 0,
      spuriousAuto: 0,
      missed: 0,
    },
  };
}

/** Fold one fixture's extraction into the running confidence report, using the real gate. */
export function accumulateConfidence(
  rep: ConfidenceReport,
  label: ExpectedFiling,
  extracted: ExtractedFiling,
): void {
  const projected = projectExtracted(extracted).transactions;
  const validated = validateExtraction(extracted, {
    filingDate: label.filing.filing_date,
    expectedFiler: label.filing.filer_name,
    threshold: rep.threshold,
  });
  const { pairs, missedIdx, spuriousIdx } = matchRows(label.transactions, projected);

  rep.gate.missed += missedIdx.length;
  for (const ai of spuriousIdx) {
    rep.gate.spurious++;
    if (!validated.trades[ai]?.needsReview) rep.gate.spuriousAuto++;
  }

  for (const { ei, ai } of pairs) {
    const e = label.transactions[ei];
    const a = projected[ai];
    const raw = extracted.transactions[ai];
    let allCorrect = true;
    for (const f of ESSENTIAL_FIELDS) {
      const ok = essentialCorrect(f, e, a);
      const hi = essentialConfidence(raw, f) >= rep.threshold;
      const b = rep.fields[f];
      if (hi && ok) b.hiCorrect++;
      else if (hi && !ok) b.hiWrong++;
      else if (!hi && ok) b.loCorrect++;
      else b.loWrong++;
      if (!ok) allCorrect = false;
    }
    const flagged = validated.trades[ai].needsReview;
    rep.gate.matched++;
    if (!flagged && allCorrect) rep.gate.autoCorrect++;
    else if (!flagged && !allCorrect) rep.gate.autoWrong++;
    else if (flagged && !allCorrect) rep.gate.reviewWrong++;
    else rep.gate.reviewCorrect++;
  }
}

export function formatConfidenceReport(rep: ConfidenceReport): string {
  const lines: string[] = [];
  lines.push(`\n=== ${rep.provider} — confidence vs correctness (threshold ${rep.threshold}) ===`);
  lines.push("\nessential fields (of matched rows):");
  lines.push("  field               conf&right  CONF&WRONG  unsure&right  unsure&wrong");
  for (const f of ESSENTIAL_FIELDS) {
    const b = rep.fields[f];
    lines.push(
      `  ${f.padEnd(18)} ${String(b.hiCorrect).padStart(9)}  ${String(b.hiWrong).padStart(10)}  ` +
        `${String(b.loCorrect).padStart(12)}  ${String(b.loWrong).padStart(12)}`,
    );
  }
  const g = rep.gate;
  const auto = g.autoCorrect + g.autoWrong;
  const silentRate = auto === 0 ? "n/a" : `${((100 * g.autoWrong) / auto).toFixed(1)}%`;
  const wrong = g.autoWrong + g.reviewWrong;
  const caughtRate = wrong === 0 ? "n/a" : `${((100 * g.reviewWrong) / wrong).toFixed(1)}%`;
  lines.push("\ngate outcome (matched rows):");
  lines.push(`  auto-ingest & correct   ${g.autoCorrect}`);
  lines.push(`  auto-ingest & WRONG     ${g.autoWrong}   <- silent errors`);
  lines.push(`  review & wrong          ${g.reviewWrong}   <- correctly caught`);
  lines.push(`  review & correct        ${g.reviewCorrect}   <- false alarms`);
  lines.push(`  spurious rows           ${g.spurious} (${g.spuriousAuto} would auto-ingest)`);
  lines.push(`  missed rows             ${g.missed}`);
  lines.push(
    `\n  silent-error rate (of auto-ingested): ${silentRate}` +
      `   |   wrong rows caught by gate: ${caughtRate}`,
  );
  return lines.join("\n");
}
