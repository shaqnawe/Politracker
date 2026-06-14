import { HORIZONS, MIN_SAMPLE, type HorizonLabel } from "./returns.js";

/**
 * Shared roll-up used by both analysis models. Given per-event signed abnormal returns, group them
 * (per member / per ticker / per figure) and report, for each horizon: sample size, mean, median,
 * dispersion (std), and hit rate — never a bare average (spec §9). Small groups are flagged
 * low-confidence. Optional per-event weights drive a weighted mean (Model B: amount-range midpoint).
 *
 * This is descriptive correlation analysis, not inference: see each model's methodology report for
 * the caveats (reverse causation, look-ahead, overlapping windows) that limit what these mean.
 */

export interface ScoredEvent {
  group: string;
  /** Signed abnormal return per horizon; null where the engine couldn't resolve that horizon. */
  signed: Partial<Record<HorizonLabel, number | null>>;
  /** Optional weight (e.g. trade amount-range midpoint). Defaults to 1. */
  weight?: number;
  /** Optional sub-tag carried through for reporting (e.g. 'online' vs 'ocr'). */
  tag?: string;
}

export interface HorizonAgg {
  n: number;
  mean: number | null;
  median: number | null;
  std: number | null; // sample standard deviation
  hitRate: number | null; // fraction with signed return > 0
  weightedMean: number | null;
}

export interface GroupAgg {
  group: string;
  /** Distinct events in the group with at least one resolved horizon. */
  nEvents: number;
  /** True when nEvents < minSample — treat the numbers as unreliable. */
  lowConfidence: boolean;
  horizons: Record<HorizonLabel, HorizonAgg>;
}

const HLABELS = Object.keys(HORIZONS) as HorizonLabel[];

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function stddev(xs: number[]): number | null {
  if (xs.length < 2) return null; // undefined dispersion for n<2
  const mu = mean(xs)!;
  const v = xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function horizonAgg(rows: { v: number; w: number }[]): HorizonAgg {
  const vs = rows.map((r) => r.v);
  const wsum = rows.reduce((a, r) => a + r.w, 0);
  const wMean = wsum > 0 ? rows.reduce((a, r) => a + r.w * r.v, 0) / wsum : null;
  return {
    n: vs.length,
    mean: mean(vs),
    median: median(vs),
    std: stddev(vs),
    hitRate: vs.length ? vs.filter((v) => v > 0).length / vs.length : null,
    weightedMean: wMean,
  };
}

export interface AggregateOptions {
  minSample?: number;
}

/** Roll a flat list of scored events up by their `group` key. */
export function aggregate(events: ScoredEvent[], opts: AggregateOptions = {}): GroupAgg[] {
  const minSample = opts.minSample ?? MIN_SAMPLE;
  const byGroup = new Map<string, ScoredEvent[]>();
  for (const e of events) (byGroup.get(e.group) ?? byGroup.set(e.group, []).get(e.group)!).push(e);

  const out: GroupAgg[] = [];
  for (const [group, evs] of byGroup) {
    const horizons = {} as Record<HorizonLabel, HorizonAgg>;
    let resolvedEvents = 0;
    const hasAnyResolved = (e: ScoredEvent) => HLABELS.some((h) => typeof e.signed[h] === "number");
    resolvedEvents = evs.filter(hasAnyResolved).length;
    for (const h of HLABELS) {
      const rows = evs
        .filter((e) => typeof e.signed[h] === "number")
        .map((e) => ({ v: e.signed[h] as number, w: e.weight ?? 1 }));
      horizons[h] = horizonAgg(rows);
    }
    out.push({ group, nEvents: resolvedEvents, lowConfidence: resolvedEvents < minSample, horizons });
  }
  // Most-active first.
  out.sort((a, b) => b.nEvents - a.nEvents);
  return out;
}

/** Convenience: aggregate everything as a single group (overall summary). */
export function aggregateOverall(events: ScoredEvent[], label = "ALL", opts: AggregateOptions = {}): GroupAgg {
  return aggregate(events.map((e) => ({ ...e, group: label })), opts)[0] ?? {
    group: label,
    nEvents: 0,
    lowConfidence: true,
    horizons: Object.fromEntries(HLABELS.map((h) => [h, horizonAgg([])])) as Record<HorizonLabel, HorizonAgg>,
  };
}
